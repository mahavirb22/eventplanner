# Gatherly — Celebration & Event Planner

Gatherly is a GenAI-powered planning assistant for weddings, birthdays, and
community events. It is being built incrementally for the PromptWars
Celebration & Event Planner challenge.

## Current status

### Phase 1 — Foundation (complete)

- Express 5 server with Helmet, CORS, compression, rate limiting, and JSON
  body limits.
- Accessible responsive SPA shell with skip navigation, landmarks, labels,
  focus states, and reduced-motion support.
- Initial event setup form for occasion, guest count, and budget.
- Validated `POST /api/preview-plan` endpoint.
- Jest + Supertest baseline coverage.

### Phase 2 — Planning engine (complete)

- Event-specific budget categories with percentages and exact total allocation.
- Date-aware milestones, with relative milestones when no date is supplied.
- Vendor/task checklist with independently checkable items in the browser.
- Personalized celebration ideas based on event type and guest count.
- Server-side date validation and XSS-safe client-side rendering.

### Phase 3 — AI planning assistant (complete)

- Gemini-backed `/api/chat` endpoint with a planning-specific system prompt.
- Demo mode with a useful response when `GEMINI_API_KEY` is not configured.
- Server-side message, plan-context, and conversation-history validation.
- Bounded history (last 10 messages) and generation limits.
- Accessible chat UI that includes the current event setup as context.
- Explicit `502` responses for empty or unavailable provider responses.

### Phase 4 — Google services (complete)

- Cloud Translation adapter with Gemini fallback and no-key demo mode.
- Gemini 3.1 Flash TTS adapter with validated Indian locale support.
- Google Calendar deep links for saving an event date.
- Google Maps venue search links.
- Browser speech fallback for immediate local playback.
- Accessible translation and shortcut tools in the planner UI.

The blueprint listed older package versions that are no longer published in the
current npm registry. The project uses the currently published compatible
version: `@google-cloud/translate@^10.3.0`.

### Phase 5 — Persistence and workspace identity (complete)

- New `POST /api/plans` and `GET /api/plans` persistence endpoints.
- Whitelisted plan payloads and opaque workspace ID validation.
- Demo in-memory persistence for local development and tests.
- Firestore adapter activated only when Firebase Admin credentials are present.
- Browser-local workspace ID for saving and restoring plans without sign-in.
- Accessible save and saved-plan controls in the planner UI.

This phase deliberately does not claim account authentication: the browser uses
an anonymous local workspace ID, and no user identity is trusted by the server.
Firebase Admin persistence is ready for the authenticated identity layer in a
future hardening pass.

### Phase 6 — Testing and deployment (complete)

- 18 Jest + Supertest backend tests covering APIs, validation, integrations,
  persistence, SPA delivery, and security headers.
- 5 Playwright E2E tests covering accessibility landmarks, labelled controls,
  plan generation, AI demo chat, and Google tool surfaces.
- Playwright configuration with an explicit E2E server mode.
- Dockerfile with dependency-layer caching, non-root execution, and healthcheck.
- `.dockerignore`, `.gitattributes`, and Vercel rewrite configuration.
- Production startup compatibility for CommonJS Google Cloud packages.

### Planned phases

The planned implementation phases are complete. Optional future work includes
verified Firebase Authentication, richer saved-plan editing, and broader
visual regression coverage.

## Run locally

```bash
npm install
copy .env.example .env
npm start
```

Open `http://localhost:8080`.

Run the API tests:

```bash
npm test -- --runInBand
```

Run the browser tests:

```bash
npm run test:e2e
```

Run both suites:

```bash
npm run test:all
```

Build and run the container:

```bash
docker build -t gatherly .
docker run --env-file .env -p 8080:8080 gatherly
```

API keys are intentionally optional during early phases. Features that require
them will be added behind explicit configuration checks.
