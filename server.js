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
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "telegram-webhook";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

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
const model = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
});

async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text,
  });
}

async function saveMessage(userId, role, text) {
  await db.collection("users").doc(String(userId)).collection("messages").add({
    role,
    text,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
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
  snap.forEach((doc) => messages.push(doc.data()));
  return messages.reverse();
}

async function buildPrompt(userId, userText) {
  const history = await getRecentMessages(userId, 12);

  const formattedHistory = history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`)
    .join("\n");

  return `
You are a personal assistant for the user.
Be helpful, practical, organized, and concise.
Remember the user's preferences from the conversation history when relevant.

Conversation history:
${formattedHistory}

User: ${userText}
Assistant:
`;
}

app.get("/", (req, res) => {
  res.send("Telegram Gemini Assistant is running.");
});

app.post(`/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (!update.message || !update.message.text) {
      return res.sendStatus(200);
    }

    const chatId = update.message.chat.id;
    const userId = update.message.from.id;
    const userText = update.message.text.trim();

    if (userText === "/start") {
      await sendTelegramMessage(
        chatId,
        "Assalamu alaikum! আমি তোমার personal assistant bot. আমাকে message দাও."
      );
      return res.sendStatus(200);
    }

    await saveMessage(userId, "user", userText);

    const prompt = await buildPrompt(userId, userText);

    const result = await model.generateContent(prompt);
    const reply =
      result.response.text()?.trim() || "দুঃখিত, এখন reply generate করতে পারিনি।";

    await saveMessage(userId, "assistant", reply);
    await sendTelegramMessage(chatId, reply);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error?.response?.data || error.message || error);
    return res.sendStatus(200);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});