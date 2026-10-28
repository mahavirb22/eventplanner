/**
 * @fileoverview Celebration & Event Planner Express backend.
 * @description Phase 1-5 server foundation with secure middleware,
 * deterministic planning, AI assistance, optional Google services, Firestore
 * persistence, and static SPA delivery.
 * @module server
 */

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import translatePackage from '@google-cloud/translate';
import compression from 'compression';
import cors from 'cors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const { Translate } = translatePackage;
const isTestEnv = process.env.NODE_ENV === 'test';
const port = Number(process.env.PORT || 8080);
const geminiModelName = 'gemini-3-flash-preview';
const demoPlans = new Map();
let firestore;

/**
 * Loads Firestore only when complete server credentials are configured.
 * @returns {Promise<*>} Firestore instance or null for demo mode.
 */
async function getFirestore() {
  if (firestore !== undefined) return firestore;
  const hasCredentials = process.env.FIREBASE_PROJECT_ID
    && process.env.FIREBASE_CLIENT_EMAIL
    && process.env.FIREBASE_PRIVATE_KEY;
  if (!hasCredentials) {
    firestore = null;
    return firestore;
  }
  try {
    const { cert, getApps, initializeApp } = await import('firebase-admin/app');
    const { getFirestore } = await import('firebase-admin/firestore');
    const app = getApps().length
      ? getApps()[0]
      : initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    firestore = getFirestore(app);
    return firestore;
  } catch (error) {
    console.error('Firestore initialization failed:', error instanceof Error ? error.message : error);
    firestore = null;
    return firestore;
  }
}

/**
 * Validates the anonymous workspace identifier used by the browser.
 * @param {*} value - Candidate workspace ID.
 * @returns {{valid: boolean, error?: {error: object}}} Validation result.
 */
function validateWorkspaceId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{12,80}$/.test(value)) {
    return {
      valid: false,
      error: createError('VALIDATION_ERROR', 'Workspace ID is invalid.'),
    };
  }
  return { valid: true };
}

/**
 * Validates and limits the saved plan payload.
 * @param {*} plan - Candidate plan.
 * @returns {{valid: boolean, error?: {error: object}}} Validation result.
 */
function validateSavedPlan(plan) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { valid: false, error: createError('VALIDATION_ERROR', 'Plan must be an object.') };
  }
  const allowed = ['eventType', 'guestCount', 'budget', 'eventDate', 'plan'];
  if (Object.keys(plan).some((key) => !allowed.includes(key))) {
    return { valid: false, error: createError('VALIDATION_ERROR', 'Plan contains unsupported fields.') };
  }
  if (typeof plan.eventType !== 'string' || plan.eventType.length > 100
    || !Number.isInteger(plan.guestCount) || !Number.isFinite(plan.budget)
    || (plan.eventDate !== null && !isValidISODate(plan.eventDate))
    || !plan.plan || typeof plan.plan !== 'object') {
    return { valid: false, error: createError('VALIDATION_ERROR', 'Plan data is invalid.') };
  }
  if (JSON.stringify(plan).length > 50_000) {
    return { valid: false, error: createError('TEXT_TOO_LONG', 'Plan is too large to save.') };
  }
  return { valid: true };
}

/**
 * Creates a consistent API error payload.
 * @param {string} code - Stable machine-readable error code.
 * @param {string} message - Safe message for the client.
 * @returns {{error: {code: string, message: string}}} Error payload.
 */
function createError(code, message) {
  return { error: { code, message } };
}

/**
 * Validates a request string.
 * @param {*} value - Value to validate.
 * @param {string} name - Field name used in the error.
 * @param {number} [maxLength=200] - Maximum accepted length.
 * @returns {{valid: boolean, error?: {code: string, message: string}}} Validation result.
 */
function validateString(value, name, maxLength = 200) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { valid: false, error: createError('MISSING_FIELD', `${name} is required.`) };
  }
  if (value.length > maxLength) {
    return {
      valid: false,
      error: createError('TEXT_TOO_LONG', `${name} must be ${maxLength} characters or fewer.`),
    };
  }
  return { valid: true };
}

/**
 * Builds the planning assistant's safety and behavior instructions.
 * @returns {string} System instruction for Gemini.
 */
function buildSystemPrompt() {
  return `You are Gatherly, a warm and practical celebration planning assistant.
Help users plan weddings, birthdays, community events, and other celebrations.
Use the supplied event context when available. Give concrete, budget-aware steps
and ask one focused follow-up question when important details are missing.
Be inclusive, non-judgmental, and concise. Never invent vendor availability,
prices, legal requirements, or safety claims. Explain that estimates are starting
points. Do not provide medical, legal, or financial advice. If a request is
unrelated to event planning, politely redirect it to the celebration plan.`;
}

/**
 * Validates the bounded conversation history sent by the browser.
 * @param {*} history - Candidate history array.
 * @returns {{valid: boolean, value?: Array, error?: {error: object}}} Validation result.
 */
function validateChatHistory(history) {
  if (history === undefined) {
    return { valid: true, value: [] };
  }
  if (!Array.isArray(history) || history.length > 20) {
    return {
      valid: false,
      error: createError('VALIDATION_ERROR', 'History must be an array with at most 20 messages.'),
    };
  }
  const validRoles = new Set(['user', 'model']);
  const value = history.slice(-10);
  if (!value.every((item) => item && validRoles.has(item.role) && typeof item.text === 'string' && item.text.length <= 1000)) {
    return {
      valid: false,
      error: createError('VALIDATION_ERROR', 'Each history message needs a valid role and text.'),
    };
  }
  return { valid: true, value };
}

const PLAN_TEMPLATES = {
  Wedding: {
    categories: [
      ['Venue & catering', 0.4],
      ['Photography & video', 0.15],
      ['Decor & florals', 0.15],
      ['Attire & beauty', 0.1],
      ['Music & entertainment', 0.1],
      ['Contingency', 0.1],
    ],
    checklist: ['Book venue and catering', 'Confirm photographer', 'Choose decor palette', 'Send invitations', 'Create a day-of emergency kit'],
    ideas: ['Add a memory table with photos from both families', 'Plan one quiet pause for the couple during the celebration', 'Use seasonal flowers to make the decor more personal'],
  },
  Birthday: {
    categories: [
      ['Venue & food', 0.35],
      ['Decor & setup', 0.2],
      ['Cake & dessert', 0.15],
      ['Activities & entertainment', 0.15],
      ['Gifts & favors', 0.05],
      ['Contingency', 0.1],
    ],
    checklist: ['Choose a venue or hosting space', 'Order the cake', 'Plan the main activity', 'Send invitations', 'Prepare a welcome and cleanup plan'],
    ideas: ['Create a guest-submitted playlist', 'Set up a low-pressure photo prompt wall', 'Offer one activity that works across age groups'],
  },
  'Community event': {
    categories: [
      ['Venue & permits', 0.2],
      ['Food & refreshments', 0.25],
      ['Equipment & accessibility', 0.15],
      ['Promotion & materials', 0.15],
      ['Volunteers & activities', 0.15],
      ['Contingency', 0.1],
    ],
    checklist: ['Confirm venue and required permits', 'Assign volunteer leads', 'Plan access and seating', 'Share event details locally', 'Create a weather backup plan'],
    ideas: ['Invite a local maker or storyteller to lead a short activity', 'Add a quiet area for guests who need a break', 'Use reusable signage and serving supplies'],
  },
  'Other celebration': {
    categories: [
      ['Venue & food', 0.35],
      ['Decor & atmosphere', 0.2],
      ['Activities', 0.15],
      ['Supplies & materials', 0.15],
      ['Guest experience', 0.05],
      ['Contingency', 0.1],
    ],
    checklist: ['Choose the setting', 'Build a guest list', 'Plan food and refreshments', 'Gather supplies', 'Confirm the run of show'],
    ideas: ['Choose one sensory detail as a theme anchor', 'Create a small ritual guests can participate in', 'Design a take-home note or token'],
  },
};

/**
 * Builds a practical first event plan from validated setup details.
 * @param {{eventType: string, guestCount: number, budget: number, eventDate?: string}} details - Event setup.
 * @returns {{budgetBreakdown: Array, timeline: Array, vendorChecklist: Array, ideas: Array}} Generated plan.
 */
function buildPlan({ eventType, guestCount, budget, eventDate }) {
  const template = PLAN_TEMPLATES[eventType] || PLAN_TEMPLATES['Other celebration'];
  const budgetBreakdown = template.categories.map(([name, share]) => ({
    name,
    percentage: Math.round(share * 100),
    amount: Math.round(budget * share),
  }));
  const allocated = budgetBreakdown.reduce((total, item) => total + item.amount, 0);
  budgetBreakdown[budgetBreakdown.length - 1].amount += budget - allocated;
  const timeline = eventDate
    ? [
        { milestone: 'Finalize guest list and priorities', timing: '8 weeks before', date: shiftDate(eventDate, -56) },
        { milestone: 'Confirm key vendors and supplies', timing: '4 weeks before', date: shiftDate(eventDate, -28) },
        { milestone: 'Send final details to guests', timing: '1 week before', date: shiftDate(eventDate, -7) },
        { milestone: 'Celebrate and review the run of show', timing: 'Event day', date: eventDate },
      ]
    : [
        { milestone: 'Finalize guest list and priorities', timing: 'Start here' },
        { milestone: 'Confirm key vendors and supplies', timing: 'Next step' },
        { milestone: 'Send final details to guests', timing: 'One week before' },
        { milestone: 'Celebrate and review the run of show', timing: 'Event day' },
      ];

  return {
    budgetBreakdown,
    timeline,
    vendorChecklist: template.checklist.map((task, index) => ({
      id: `${eventType.toLowerCase().replaceAll(' ', '-')}-${index + 1}`,
      task,
      completed: false,
    })),
    ideas: template.ideas.map((idea) => ({ idea, fit: `${guestCount} guests` })),
  };
}

/**
 * Shifts an ISO calendar date by a number of days.
 * @param {string} dateValue - ISO date string.
 * @param {number} days - Days to add or subtract.
 * @returns {string} Shifted ISO date.
 */
function shiftDate(dateValue, days) {
  const date = new Date(`${dateValue}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Checks that a value is a real calendar date in ISO format.
 * @param {*} value - Date value to inspect.
 * @returns {boolean} Whether the value is a valid ISO date.
 */
function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const SUPPORTED_LANGUAGES = {
  hindi: 'hi',
  tamil: 'ta',
  telugu: 'te',
  bengali: 'bn',
  marathi: 'mr',
  gujarati: 'gu',
  kannada: 'kn',
  malayalam: 'ml',
  punjabi: 'pa',
  urdu: 'ur',
  odia: 'or',
  assamese: 'as',
};

/**
 * Creates a Google Calendar event URL without requiring OAuth.
 * @param {{title: string, date?: string, details?: string}} event - Event details.
 * @returns {string} Calendar deep link.
 */
function buildCalendarLink({ title, date, details }) {
  const datePart = date ? date.replaceAll('-', '') : '';
  const dates = datePart ? `${datePart}/${datePart}` : '';
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    details: details || 'Planned with Gatherly',
  });
  if (dates) params.set('dates', dates);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Creates a Google Maps search URL for venue discovery.
 * @param {string} query - Venue search query.
 * @returns {string} Maps search deep link.
 */
function buildMapsLink(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET', 'POST'],
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: isTestEnv ? 10_000 : 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: createError('RATE_LIMITED', 'Too many requests. Please try again shortly.'),
  skip: () => isTestEnv,
});

const chatLimiter = rateLimit({
  windowMs: 60_000,
  max: isTestEnv ? 10_000 : 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: createError('RATE_LIMITED', 'Too many planning messages. Please try again shortly.'),
  skip: () => isTestEnv,
});

app.get('/api/health', (_req, res) => {
  res.set('Cache-Control', 'no-store').json({
    status: 'ok',
    service: 'celebration-planner',
    phase: 6,
  });
});

app.get('/api/config', apiLimiter, (_req, res) => {
  res.set('Cache-Control', 'public, max-age=3600').json({
    aiAvailable: Boolean(process.env.GEMINI_API_KEY),
    firebaseAvailable: Boolean(process.env.FIREBASE_PROJECT_ID),
    persistenceMode: process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY ? 'firestore' : 'demo',
  });
});

app.post('/api/preview-plan', apiLimiter, (req, res) => {
  const { eventType, guestCount, budget } = req.body ?? {};
  const submittedEventDate = req.body?.eventDate;
  const eventDate = submittedEventDate === '' ? undefined : submittedEventDate;
  const fields = [
    validateString(eventType, 'Event type'),
    validateString(String(guestCount ?? ''), 'Guest count', 10),
    validateString(String(budget ?? ''), 'Budget', 20),
  ];
  const invalid = fields.find((field) => !field.valid);
  if (invalid) {
    return res.status(400).json(invalid.error);
  }

  const guests = Number(guestCount);
  const amount = Number(budget);
  if (!Number.isInteger(guests) || guests < 1 || guests > 10_000) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Guest count must be between 1 and 10,000.'));
  }
  if (!Number.isFinite(amount) || amount < 1) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Budget must be a positive number.'));
  }
  if (eventDate !== undefined && !isValidISODate(eventDate)) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Event date must use YYYY-MM-DD format.'));
  }

  return res.status(200).json({
    eventType: eventType.trim(),
    guestCount: guests,
    budget: amount,
    eventDate: eventDate || null,
    status: 'ready-for-planning',
    plan: buildPlan({ eventType: eventType.trim(), guestCount: guests, budget: amount, eventDate }),
  });
});

app.post('/api/plans', apiLimiter, async (req, res) => {
  const { workspaceId, plan } = req.body ?? {};
  const workspaceValidation = validateWorkspaceId(workspaceId);
  if (!workspaceValidation.valid) return res.status(400).json(workspaceValidation.error);
  const planValidation = validateSavedPlan(plan);
  if (!planValidation.valid) return res.status(400).json(planValidation.error);

  const record = {
    id: randomUUID(),
    workspaceId,
    ...plan,
    createdAt: new Date().toISOString(),
  };
  try {
    const database = await getFirestore();
    if (database) {
      await database.collection('plans').doc(record.id).set(record);
    } else {
      const existing = demoPlans.get(workspaceId) || [];
      demoPlans.set(workspaceId, [record, ...existing].slice(0, 20));
    }
    return res.status(201).json({
      id: record.id,
      createdAt: record.createdAt,
      persistence: database ? 'firestore' : 'demo',
    });
  } catch (error) {
    console.error('Plan save failed:', error instanceof Error ? error.message : error);
    return res.status(502).json(createError('PERSISTENCE_UNAVAILABLE', 'The plan could not be saved right now.'));
  }
});

app.get('/api/plans', apiLimiter, async (req, res) => {
  const { workspaceId } = req.query;
  const workspaceValidation = validateWorkspaceId(workspaceId);
  if (!workspaceValidation.valid) return res.status(400).json(workspaceValidation.error);
  try {
    const database = await getFirestore();
    let plans;
    if (database) {
      const snapshot = await database.collection('plans')
        .where('workspaceId', '==', workspaceId)
        .limit(20)
        .get();
      plans = snapshot.docs.map((document) => document.data());
    } else {
      plans = demoPlans.get(workspaceId) || [];
    }
    return res.status(200).json({
      plans: plans.map(({ workspaceId: _workspaceId, ...plan }) => plan),
      persistence: database ? 'firestore' : 'demo',
    });
  } catch (error) {
    console.error('Plan load failed:', error instanceof Error ? error.message : error);
    return res.status(502).json(createError('PERSISTENCE_UNAVAILABLE', 'Saved plans are temporarily unavailable.'));
  }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message, history, planContext } = req.body ?? {};
  const messageValidation = validateString(message, 'Message', 1000);
  if (!messageValidation.valid) {
    return res.status(400).json(messageValidation.error);
  }
  const historyValidation = validateChatHistory(history);
  if (!historyValidation.valid) {
    return res.status(400).json(historyValidation.error);
  }
  if (planContext !== undefined && (typeof planContext !== 'object' || planContext === null || Array.isArray(planContext))) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Plan context must be an object.'));
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(200).json({
      reply: 'I can help shape your celebration plan. Add your event date, priorities, or one detail you want guests to remember, and we can refine the next step together.',
      demo: true,
    });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: geminiModelName,
      systemInstruction: buildSystemPrompt(),
    });
    const context = planContext ? `\nCurrent plan context:\n${JSON.stringify(planContext).slice(0, 5000)}` : '';
    const chat = model.startChat({
      history: [
        ...historyValidation.value.map((item) => ({
          role: item.role,
          parts: [{ text: item.text }],
        })),
      ],
      generationConfig: { maxOutputTokens: 512, temperature: 0.4, topP: 0.9 },
    });
    const result = await chat.sendMessage(`${message.trim()}${context}`);
    const reply = result.response.text();
    if (!reply || reply.trim().length === 0) {
      return res.status(502).json(createError('AI_EMPTY_RESPONSE', 'The planning assistant returned an empty response.'));
    }
    return res.status(200).json({ reply: reply.trim(), demo: false });
  } catch (error) {
    console.error('Gemini planning request failed:', error instanceof Error ? error.message : error);
    return res.status(502).json(createError('AI_UNAVAILABLE', 'The planning assistant is temporarily unavailable.'));
  }
});

app.post('/api/translate', apiLimiter, async (req, res) => {
  const { text, language } = req.body ?? {};
  const textValidation = validateString(text, 'Text', 2000);
  if (!textValidation.valid) return res.status(400).json(textValidation.error);
  const languageKey = typeof language === 'string' ? language.toLowerCase() : '';
  const targetCode = SUPPORTED_LANGUAGES[languageKey];
  if (!targetCode) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Choose a supported Indian language.'));
  }
  if (!process.env.GOOGLE_CLOUD_API_KEY && !process.env.GEMINI_API_KEY) {
    return res.status(200).json({
      translated: text.trim(),
      language: languageKey,
      service: 'demo',
      demo: true,
    });
  }

  try {
    if (process.env.GOOGLE_CLOUD_API_KEY) {
      const translate = new Translate({ key: process.env.GOOGLE_CLOUD_API_KEY });
      const [translated] = await translate.translate(text.trim(), targetCode);
      return res.status(200).json({ translated, language: languageKey, service: 'cloud-translation', demo: false });
    }
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: geminiModelName });
    const result = await model.generateContent({
      contents: [{ parts: [{ text: `Translate only this event-planning text to ${languageKey}:\n\n${text.trim()}` }] }],
      generationConfig: { maxOutputTokens: 256, temperature: 0.2 },
    });
    return res.status(200).json({
      translated: result.response.text().trim(),
      language: languageKey,
      service: 'gemini-translation',
      demo: false,
    });
  } catch (error) {
    console.error('Translation request failed:', error instanceof Error ? error.message : error);
    return res.status(502).json(createError('TRANSLATION_UNAVAILABLE', 'Translation is temporarily unavailable.'));
  }
});

app.post('/api/text-to-speech', apiLimiter, async (req, res) => {
  const { text, language = 'en-IN' } = req.body ?? {};
  const textValidation = validateString(text, 'Text', 500);
  if (!textValidation.valid) return res.status(400).json(textValidation.error);
  if (typeof language !== 'string' || !/^[a-z]{2}-IN$/i.test(language)) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Language must use an Indian locale such as en-IN.'));
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(200).json({ audio: null, language, service: 'demo', demo: true });
  }

  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({
      model: 'gemini-3.1-flash-tts',
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
        },
      },
    });
    const result = await model.generateContent({
      contents: [{
        parts: [{
          text: `Read this text aloud in the ${language} locale. Return only the spoken audio:\n\n${text.trim()}`,
        }],
      }],
    });
    const audioPart = result.response.candidates?.[0]?.content?.parts
      ?.find((part) => part.inlineData?.data);
    if (!audioPart) {
      return res.status(502).json(createError('SPEECH_EMPTY_RESPONSE', 'Speech service returned no audio.'));
    }
    const mimeType = audioPart.inlineData.mimeType || 'audio/wav';
    return res.status(200).json({
      audio: audioPart.inlineData.data,
      format: mimeType,
      language,
      service: 'gemini-3.1-flash-tts',
      demo: false,
    });
  } catch (error) {
    console.error('Gemini text-to-speech request failed:', error instanceof Error ? error.message : error);
    return res.status(502).json(createError('SPEECH_UNAVAILABLE', 'Text-to-speech is temporarily unavailable.'));
  }
});

app.post('/api/calendar-link', apiLimiter, (req, res) => {
  const { title, date, details } = req.body ?? {};
  const titleValidation = validateString(title, 'Title', 200);
  if (!titleValidation.valid) return res.status(400).json(titleValidation.error);
  if (date !== undefined && !isValidISODate(date)) {
    return res.status(400).json(createError('VALIDATION_ERROR', 'Date must use YYYY-MM-DD format.'));
  }
  return res.status(200).json({ url: buildCalendarLink({ title: title.trim(), date, details }), service: 'google-calendar' });
});

app.post('/api/maps-link', apiLimiter, (req, res) => {
  const { query } = req.body ?? {};
  const queryValidation = validateString(query, 'Query', 200);
  if (!queryValidation.valid) return res.status(400).json(queryValidation.error);
  return res.status(200).json({ url: buildMapsLink(query.trim()), service: 'google-maps' });
});

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  maxAge: '1h',
}));

app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  console.error('Unhandled request error:', error);
  res.status(500).json(createError('INTERNAL_ERROR', 'Something went wrong. Please try again.'));
});

let server;
if (!isTestEnv || process.env.E2E === 'true') {
  server = app.listen(port, () => {
    console.log(`Celebration Planner listening on port ${port}`);
  });
}

export { app, server, validateString, buildPlan, buildCalendarLink, buildMapsLink };
export default app;
