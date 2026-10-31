import { jest } from '@jest/globals';
import supertest from 'supertest';

process.env.NODE_ENV = 'test';
process.env.PORT = '0';

const sendMessage = jest.fn().mockResolvedValue({
  response: { text: () => 'Start by confirming the guest experience you want to create.' },
});
const generateContent = jest.fn().mockResolvedValue({
  response: {
    candidates: [{
      content: { parts: [{ inlineData: { data: 'mock-audio', mimeType: 'audio/wav' } }] },
    }],
  },
});
const translate = jest.fn().mockResolvedValue(['नमस्ते']);
jest.unstable_mockModule('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      startChat: jest.fn().mockReturnValue({ sendMessage }),
      generateContent,
    }),
  })),
}));
jest.unstable_mockModule('@google-cloud/translate', () => ({
  default: {
    Translate: jest.fn().mockImplementation(() => ({ translate })),
  },
  Translate: jest.fn().mockImplementation(() => ({ translate })),
}));

const { default: app } = await import('./server.js');
const api = supertest(app);

describe('Celebration Planner API', () => {
  test('reports service health', async () => {
    const response = await api.get('/api/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', phase: 6 });
  });

  test('serves the accessible SPA shell', async () => {
    const response = await api.get('/');
    expect(response.status).toBe(200);
    expect(response.text).toContain('id="main-content"');
    expect(response.text).toContain('Skip to main content');
  });

  test('validates a preview plan', async () => {
    const response = await api.post('/api/preview-plan').send({
      eventType: 'Birthday',
      guestCount: '40',
      budget: '2500',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ eventType: 'Birthday', guestCount: 40, budget: 2500 });
    expect(response.body.plan.budgetBreakdown).toHaveLength(6);
    expect(response.body.plan.vendorChecklist.length).toBeGreaterThan(0);
    expect(response.body.plan.ideas.length).toBeGreaterThan(0);
  });

  test('builds date-aware milestones', async () => {
    const response = await api.post('/api/preview-plan').send({
      eventType: 'Wedding',
      guestCount: 120,
      budget: 15000,
      eventDate: '2026-12-20',
    });
    expect(response.status).toBe(200);
    expect(response.body.plan.timeline[0]).toMatchObject({
      timing: '8 weeks before',
      date: '2026-10-25',
    });
  });

  test('rejects invalid plan values', async () => {
    const response = await api.post('/api/preview-plan').send({
      eventType: '',
      guestCount: 0,
      budget: -1,
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('MISSING_FIELD');
  });

  test('rejects malformed event dates', async () => {
    const response = await api.post('/api/preview-plan').send({
      eventType: 'Birthday',
      guestCount: 10,
      budget: 1000,
      eventDate: 'next Saturday',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects impossible calendar dates', async () => {
    const response = await api.post('/api/preview-plan').send({
      eventType: 'Birthday',
      guestCount: 10,
      budget: 1000,
      eventDate: '2026-02-30',
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns a useful demo response without an AI key', async () => {
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    const response = await api.post('/api/chat').send({ message: 'Help me plan my birthday.' });
    if (savedKey) process.env.GEMINI_API_KEY = savedKey;
    expect(response.status).toBe(200);
    expect(response.body.demo).toBe(true);
    expect(response.body.reply).toContain('celebration plan');
  });

  test('sends validated history and context to Gemini when configured', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const response = await api.post('/api/chat').send({
      message: 'What should I do next?',
      history: [{ role: 'user', text: 'I am planning a wedding.' }],
      planContext: { eventType: 'Wedding', guestCount: 80, budget: 12000 },
    });
    delete process.env.GEMINI_API_KEY;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ demo: false, reply: expect.stringContaining('guest experience') });
    expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('What should I do next?'));
  });

  test('rejects invalid chat history', async () => {
    const response = await api.post('/api/chat').send({
      message: 'Help me plan.',
      history: [{ role: 'admin', text: 'unsafe' }],
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('rejects malformed JSON request bodies', async () => {
    const response = await api
      .post('/api/preview-plan')
      .set('Content-Type', 'application/json')
      .send('{"eventType":');
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('returns a demo translation without service keys', async () => {
    const response = await api.post('/api/translate').send({
      text: 'Welcome to our celebration',
      language: 'hindi',
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ demo: true, service: 'demo', translated: 'Welcome to our celebration' });
  });

  test('translates through Cloud Translation when configured', async () => {
    process.env.GOOGLE_CLOUD_API_KEY = 'cloud-test-key';
    const response = await api.post('/api/translate').send({
      text: 'Welcome',
      language: 'hindi',
    });
    delete process.env.GOOGLE_CLOUD_API_KEY;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ translated: 'नमस्ते', service: 'cloud-translation' });
    expect(translate).toHaveBeenCalledWith('Welcome', 'hi');
  });

  test('returns demo speech without a Gemini key', async () => {
    const response = await api.post('/api/text-to-speech').send({ text: 'Welcome', language: 'en-IN' });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ audio: null, demo: true, service: 'demo' });
  });

  test('generates speech through Gemini 3.1 Flash TTS', async () => {
    process.env.GEMINI_API_KEY = 'test-key';
    const response = await api.post('/api/text-to-speech').send({ text: 'Welcome', language: 'en-IN' });
    delete process.env.GEMINI_API_KEY;
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      audio: 'mock-audio',
      format: 'audio/wav',
      service: 'gemini-3.1-flash-tts',
      demo: false,
    });
    expect(generateContent).toHaveBeenCalled();
  });

  test('generates Google Calendar and Maps links', async () => {
    const calendar = await api.post('/api/calendar-link').send({
      title: 'Birthday celebration',
      date: '2026-12-20',
      details: 'Bring a favorite memory.',
    });
    const maps = await api.post('/api/maps-link').send({ query: 'community hall near me' });
    expect(calendar.status).toBe(200);
    expect(calendar.body.url).toContain('calendar.google.com');
    expect(calendar.body.url).toContain('20261220');
    expect(maps.status).toBe(200);
    expect(maps.body.url).toContain('google.com/maps/search');
    expect(maps.body.url).toContain('community');
  });

  test('rejects unsupported translation languages', async () => {
    const response = await api.post('/api/translate').send({ text: 'Hello', language: 'klingon' });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('saves and loads a plan in demo persistence mode', async () => {
    const workspaceId = 'workspace-test-phase5';
    const planResponse = await api.post('/api/plans').send({
      workspaceId,
      plan: {
        eventType: 'Birthday',
        guestCount: 12,
        budget: 900,
        eventDate: null,
        plan: { budgetBreakdown: [], timeline: [], vendorChecklist: [], ideas: [] },
      },
    });
    expect(planResponse.status).toBe(201);
    expect(planResponse.body.persistence).toBe('demo');
    const listResponse = await api.get('/api/plans').query({ workspaceId });
    expect(listResponse.status).toBe(200);
    expect(listResponse.body.plans).toHaveLength(1);
    expect(listResponse.body.plans[0]).toMatchObject({ eventType: 'Birthday', guestCount: 12 });
  });

  test('rejects invalid workspace and saved plan data', async () => {
    const response = await api.post('/api/plans').send({
      workspaceId: 'short',
      plan: { eventType: 'Birthday' },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('sets security headers', async () => {
    const response = await api.get('/api/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-security-policy']).toBeTruthy();
  });
});
