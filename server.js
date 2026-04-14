require("dotenv").config();

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_WEBHOOK_SECRET =
  process.env.TELEGRAM_WEBHOOK_SECRET || "telegram-webhook";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(
  /\\n/g,
  "\n"
);

if (!TELEGRAM_BOT_TOKEN || !GEMINI_API_KEY) {
  console.error("Missing TELEGRAM_BOT_TOKEN or GEMINI_API_KEY");
  process.exit(1);
}

if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
  console.error("Missing Firebase service account env vars");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: FIREBASE_PROJECT_ID,
    clientEmail: FIREBASE_CLIENT_EMAIL,
    privateKey: FIREBASE_PRIVATE_KEY,
  }),
});

const db = admin.firestore();

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const primaryModel = genAI.getGenerativeModel({
  model: "gemini-3.1-flash-lite-preview",
});
const fallbackModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text,
  });
}

function sanitizeText(text = "") {
  return String(text).trim();
}

function limitText(text = "", max = 3500) {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}

async function saveMessage(userId, role, text) {
  const cleanText = sanitizeText(text);
  if (!cleanText) return;

  await db.collection("users").doc(String(userId)).collection("messages").add({
    role,
    text: cleanText,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db
    .collection("users")
    .doc(String(userId))
    .set(
      {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
}

async function getRecentMessages(userId, limit = 12) {
  const snap = await db
    .collection("users")
    .doc(String(userId))
    .collection("messages")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const messages = [];
  snap.forEach((doc) => messages.push({ id: doc.id, ...doc.data() }));
  return messages.reverse();
}

async function clearMessages(userId) {
  const snap = await db
    .collection("users")
    .doc(String(userId))
    .collection("messages")
    .get();

  const batch = db.batch();
  snap.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

async function saveMemory(userId, text) {
  const cleanText = sanitizeText(text);
  if (!cleanText) return false;

  await db.collection("users").doc(String(userId)).collection("memories").add({
    text: cleanText,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  await db
    .collection("users")
    .doc(String(userId))
    .set(
      {
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return true;
}

async function getMemories(userId, limit = 20) {
  const snap = await db
    .collection("users")
    .doc(String(userId))
    .collection("memories")
    .orderBy("createdAt", "desc")
    .limit(limit)
    .get();

  const memories = [];
  snap.forEach((doc) => memories.push({ id: doc.id, ...doc.data() }));
  return memories.reverse();
}

async function getProfile(userId) {
  const doc = await db.collection("users").doc(String(userId)).get();
  if (!doc.exists) return null;
  return doc.data();
}

async function buildPrompt(userId, userText) {
  const history = await getRecentMessages(userId, 12);
  const memories = await getMemories(userId, 12);

  const formattedHistory = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");

  const formattedMemories = memories.length
    ? memories.map((m, i) => `${i + 1}. ${m.text}`).join("\n")
    : "No saved long-term memories yet.";

  return `
You are a personal assistant for the user.
Rules:
- Reply in Bangla.
- Be practical, organized, warm, and concise.
- Use the saved memories when relevant.
- Help like a personal study-life assistant.
- Do not invent facts about the user.
- When the user's message indicates a plan, task, routine, goal, weakness, preference, or identity detail, use the saved memories if relevant.

Saved long-term memories:
${formattedMemories}

Recent conversation:
${formattedHistory}

User: ${userText}
Assistant:
`;
}

async function generateGeminiReply(prompt) {
  const retries = 3;

  async function tryModel(model, modelName) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        const reply = result?.response?.text?.()?.trim();

        if (reply) {
          return {
            ok: true,
            reply: limitText(reply, 3500),
          };
        }
      } catch (error) {
        const status = error?.status || error?.response?.status;

        if (status === 503 && attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
          continue;
        }

        console.error(`${modelName} error:`, error?.message || error);
        return {
          ok: false,
          status,
        };
      }
    }

    return {
      ok: false,
      status: null,
    };
  }

  const primaryResult = await tryModel(primaryModel, "Gemini 3.1 Flash Lite");
  if (primaryResult.ok) {
    return primaryResult.reply;
  }

  const fallbackResult = await tryModel(fallbackModel, "Gemini 2.5 Flash");
  if (fallbackResult.ok) {
    return fallbackResult.reply;
  }

  if (primaryResult.status === 503 || fallbackResult.status === 503) {
    return "এখন Gemini server-এ একটু বেশি load আছে। একটু পরে আবার চেষ্টা করো 🙏";
  }

  return "দুঃখিত, এখন reply generate করতে পারিনি।";
}

function extractCommand(text) {
  const trimmed = sanitizeText(text);
  const firstSpace = trimmed.indexOf(" ");
  if (firstSpace === -1) {
    return {
      command: trimmed.toLowerCase(),
      args: "",
    };
  }

  return {
    command: trimmed.slice(0, firstSpace).toLowerCase(),
    args: trimmed.slice(firstSpace + 1).trim(),
  };
}

async function handleStart(chatId) {
  const msg = [
    "আসসালামু আলাইকুম! আমি তোমার personal AI assistant 🤖",
    "",
    "Available commands:",
    "/remember <text> - important info save করবে",
    "/notes - saved memories দেখাবে",
    "/summary - recent chat summary দিবে",
    "/profile - basic profile info দেখাবে",
    "/clear - chat history clear করবে",
    "",
    "এখন আমাকে normal message দিলেও আমি reply দিব।",
  ].join("\n");

  await sendTelegramMessage(chatId, msg);
}

async function handleRemember(chatId, userId, args) {
  if (!args) {
    await sendTelegramMessage(
      chatId,
      "ব্যবহার করো:\n/remember amar goal medical admission"
    );
    return;
  }

  await saveMemory(userId, args);
  await sendTelegramMessage(chatId, `Saved ✅\n\n${limitText(args, 3000)}`);
}

async function handleNotes(chatId, userId) {
  const memories = await getMemories(userId, 30);

  if (!memories.length) {
    await sendTelegramMessage(chatId, "এখনও কোনো saved memory নেই।");
    return;
  }

  const text = memories
    .map((m, i) => `${i + 1}. ${m.text}`)
    .join("\n\n");

  await sendTelegramMessage(chatId, limitText(`Saved memories:\n\n${text}`));
}

async function handleProfile(chatId, userId) {
  const profile = await getProfile(userId);
  const memories = await getMemories(userId, 5);
  const messages = await getRecentMessages(userId, 5);

  const profileText = [
    "Profile overview",
    "",
    `User ID: ${userId}`,
    `Saved memories: ${memories.length > 0 ? "Yes" : "No"}`,
    `Recent chats found: ${messages.length}`,
    `Last updated: ${profile?.updatedAt ? "Available" : "Not available"}`,
  ].join("\n");

  await sendTelegramMessage(chatId, profileText);
}

async function handleClear(chatId, userId) {
  await clearMessages(userId);
  await sendTelegramMessage(chatId, "Recent chat history cleared ✅");
}

async function handleSummary(chatId, userId) {
  const history = await getRecentMessages(userId, 20);

  if (!history.length) {
    await sendTelegramMessage(chatId, "Summary করার মতো recent chat নেই।");
    return;
  }

  const conversation = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");

  const prompt = `
Summarize the following conversation in Bangla.
Make it practical and structured.
Include:
1. Main topics
2. Important user goals/preferences
3. Pending action items if any

Conversation:
${conversation}
`;

  const summary = await generateGeminiReply(prompt);
  await sendTelegramMessage(chatId, summary);
}

async function handleNormalChat(chatId, userId, userText) {
  await saveMessage(userId, "user", userText);

  const prompt = await buildPrompt(userId, userText);
  const reply = await generateGeminiReply(prompt);

  await saveMessage(userId, "assistant", reply);
  await sendTelegramMessage(chatId, reply);
}

app.get("/", (req, res) => {
  res.send("Telegram Gemini Assistant Phase 2 is running.");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "telegram-gemini-assistant",
    phase: 2,
  });
});

app.post(`/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (!update.message || !update.message.text) {
      return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const userText = sanitizeText(update.message.text);

    if (!userText) {
      return res.sendStatus(200);
    }

    const { command, args } = extractCommand(userText);

    if (command === "/start") {
      await handleStart(chatId);
      return res.sendStatus(200);
    }

    if (command === "/remember") {
      await handleRemember(chatId, userId, args);
      return res.sendStatus(200);
    }

    if (command === "/notes") {
      await handleNotes(chatId, userId);
      return res.sendStatus(200);
    }

    if (command === "/summary") {
      await handleSummary(chatId, userId);
      return res.sendStatus(200);
    }

    if (command === "/profile") {
      await handleProfile(chatId, userId);
      return res.sendStatus(200);
    }

    if (command === "/clear") {
      await handleClear(chatId, userId);
      return res.sendStatus(200);
    }

    await handleNormalChat(chatId, userId, userText);
    return res.sendStatus(200);
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.response?.data || error?.message || error
    );

    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});