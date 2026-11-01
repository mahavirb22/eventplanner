/**
 * @file app.js
 * @description Gatherly planning, AI assistant, Google tools, and accessible rendering.
 */

'use strict';

const plannerForm = document.querySelector('#planner-form');
const formMessage = document.querySelector('#form-message');
const planResults = document.querySelector('#plan-results');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const chatMessages = document.querySelector('#chat-messages');
const translateForm = document.querySelector('#translate-form');
const translateText = document.querySelector('#translate-text');
const translateLanguage = document.querySelector('#translate-language');
const translateResult = document.querySelector('#translate-result');
const calendarLink = document.querySelector('#calendar-link');
const mapsLink = document.querySelector('#maps-link');
const speakButton = document.querySelector('#speak-button');
const toolsResult = document.querySelector('#tools-result');
const savePlanButton = document.querySelector('#save-plan-button');
const loadPlansButton = document.querySelector('#load-plans-button');
const savePlanResult = document.querySelector('#save-plan-result');
const savedPlans = document.querySelector('#saved-plans');

/* ── Local Workspace State ───────────────────────────────── */

const chatHistory = [];
let latestPlan;
let savedPlanRecords = [];
const workspaceId = getWorkspaceId();

/**
 * Gets or creates a local anonymous workspace identifier.
 * @returns {string} Opaque workspace ID.
 */
function getWorkspaceId() {
  const key = 'gatherly-workspace-id';
  let id = window.localStorage.getItem(key);
  if (!id) {
    id = `workspace-${crypto.randomUUID()}`;
    window.localStorage.setItem(key, id);
  }
  return id;
}

/**
 * Submits the event setup form and reports the server response.
 * @param {SubmitEvent} event - Form submission event.
 * @returns {Promise<void>} Resolves after the request is complete.
 */
async function createStartingPoint(event) {
  event.preventDefault();
  const formData = new FormData(plannerForm);
  formMessage.textContent = 'Creating your starting point…';
  formMessage.className = 'form-message';

  try {
    const response = await fetch('/api/preview-plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || 'Unable to create a plan.');
    }
    formMessage.textContent = `${result.eventType} plan created for ${result.guestCount} guests.`;
    formMessage.className = 'form-message success';
    renderPlan(result.plan, result.budget);
    latestPlan = result;
    prepareGoogleLinks(result);
    planResults.hidden = false;
    planResults.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    formMessage.textContent = error instanceof Error ? error.message : 'Unable to create a plan.';
    formMessage.className = 'form-message error';
  }
}

plannerForm?.addEventListener('submit', createStartingPoint);

/* ── Chat ─────────────────────────────────────────────────── */

/**
 * Adds a safely-rendered message to the conversation.
 * @param {'user'|'model'} role - Message author.
 * @param {string} text - Message text.
 * @returns {void}
 */
function appendChatMessage(role, text) {
  const message = document.createElement('div');
  message.className = `chat-message ${role === 'user' ? 'chat-user' : 'chat-model'}`;
  message.textContent = text;
  chatMessages.append(message);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

/**
 * Sends a bounded conversation to the planning assistant.
 * @param {SubmitEvent} event - Form submission event.
 * @returns {Promise<void>} Resolves after the response is rendered.
 */
async function sendChatMessage(event) {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  appendChatMessage('user', message);
  chatInput.value = '';
  chatInput.disabled = true;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message,
        history: chatHistory.slice(-10),
        planContext: latestPlan ? {
          eventType: latestPlan.eventType,
          guestCount: latestPlan.guestCount,
          budget: latestPlan.budget,
          eventDate: latestPlan.eventDate,
        } : undefined,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Unable to reach the assistant.');
    appendChatMessage('model', result.reply);
    chatHistory.push({ role: 'user', text: message });
    chatHistory.push({ role: 'model', text: result.reply });
    if (chatHistory.length > 20) chatHistory.splice(0, chatHistory.length - 20);
  } catch (error) {
    appendChatMessage('model', error instanceof Error ? error.message : 'Unable to reach the assistant.');
  } finally {
    chatInput.disabled = false;
    chatInput.focus();
  }
}

chatForm?.addEventListener('submit', sendChatMessage);
appendChatMessage('model', 'Tell me what you are planning, and I will help you choose the next thoughtful step.');

/* ── Google Tools ────────────────────────────────────────── */

/**
 * Creates safe Google Calendar and Maps deep links for the current plan.
 * @param {{eventType: string, eventDate?: string, guestCount: number}} plan - Current plan.
 * @returns {void}
 */
function prepareGoogleLinks(plan) {
  calendarLink.href = `/api/calendar-link?title=${encodeURIComponent(plan.eventType)}`;
  calendarLink.dataset.title = plan.eventType;
  calendarLink.dataset.date = plan.eventDate || '';
  calendarLink.setAttribute('aria-disabled', 'false');
  mapsLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${plan.eventType} venue near me`)}`;
  mapsLink.setAttribute('aria-disabled', 'false');
}

/**
 * Requests a translation through the server-side Google service adapter.
 * @param {SubmitEvent} event - Form submission event.
 * @returns {Promise<void>} Resolves when the result is displayed.
 */
async function translateMessage(event) {
  event.preventDefault();
  translateResult.textContent = 'Translating…';
  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: translateText.value, language: translateLanguage.value }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Translation unavailable.');
    translateResult.textContent = result.translated;
  } catch (error) {
    translateResult.textContent = error instanceof Error ? error.message : 'Translation unavailable.';
  }
}

/**
 * Requests a Calendar deep link using the current plan.
 * @param {MouseEvent} event - Link activation event.
 * @returns {Promise<void>} Resolves after the link is prepared.
 */
async function createCalendarLink(event) {
  event.preventDefault();
  if (!latestPlan) {
    toolsResult.textContent = 'Create a plan first to add its date to Google Calendar.';
    return;
  }
  const response = await fetch('/api/calendar-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: `${latestPlan.eventType} · Gatherly plan`,
      date: latestPlan.eventDate || undefined,
      details: `Planning for ${latestPlan.guestCount} guests.`,
    }),
  });
  const result = await response.json();
  if (!response.ok) {
    toolsResult.textContent = result.error?.message || 'Calendar link unavailable.';
    return;
  }
  window.open(result.url, '_blank', 'noopener,noreferrer');
}

/**
 * Uses the browser speech API as a zero-key local fallback.
 * @returns {void}
 */
function readMessageAloud() {
  const text = translateText.value.trim() || 'Your celebration plan is ready for the next thoughtful step.';
  if (!('speechSynthesis' in window)) {
    toolsResult.textContent = 'Speech playback is not supported in this browser.';
    return;
  }
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  toolsResult.textContent = 'Reading your message aloud.';
}

translateForm?.addEventListener('submit', translateMessage);
calendarLink?.addEventListener('click', createCalendarLink);
speakButton?.addEventListener('click', readMessageAloud);

/**
 * Saves the current plan through the persistence adapter.
 * @returns {Promise<void>} Resolves after the save status is displayed.
 */
async function saveCurrentPlan() {
  if (!latestPlan) {
    savePlanResult.textContent = 'Create a plan before saving it.';
    return;
  }
  savePlanResult.textContent = 'Saving your plan…';
  try {
    const response = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workspaceId,
        plan: {
          eventType: latestPlan.eventType,
          guestCount: latestPlan.guestCount,
          budget: latestPlan.budget,
          eventDate: latestPlan.eventDate,
          plan: latestPlan.plan,
        },
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Unable to save the plan.');
    savePlanResult.textContent = result.persistence === 'demo'
      ? 'Saved in this browser workspace. Connect Firebase to sync across devices.'
      : 'Plan saved securely.';
  } catch (error) {
    savePlanResult.textContent = error instanceof Error ? error.message : 'Unable to save the plan.';
  }
}

/**
 * Loads saved plans for the current anonymous workspace.
 * @returns {Promise<void>} Resolves after saved plans are rendered.
 */
async function loadSavedPlans() {
  savePlanResult.textContent = 'Loading saved plans…';
  try {
    const response = await fetch(`/api/plans?workspaceId=${encodeURIComponent(workspaceId)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Unable to load saved plans.');
    savedPlanRecords = result.plans;
    savedPlans.hidden = false;
    savedPlans.innerHTML = result.plans.length
      ? `<h3>Saved plans</h3>${result.plans.map((plan) => `
          <button class="saved-plan" type="button" data-plan-id="${escHtml(plan.id)}">
            <strong>${escHtml(plan.eventType)}</strong>
            <span>${escHtml(String(plan.guestCount))} guests · ${escHtml(new Date(plan.createdAt).toLocaleDateString())}</span>
          </button>`).join('')}`
      : '<p>No saved plans yet.</p>';
    savePlanResult.textContent = result.persistence === 'demo'
      ? 'Showing plans saved in this browser workspace.'
      : 'Showing plans saved in Firebase.';
  } catch (error) {
    savePlanResult.textContent = error instanceof Error ? error.message : 'Unable to load saved plans.';
  }
}

/**
 * Restores a selected saved plan into the current UI.
 * @param {MouseEvent} event - Click event from a saved-plan button.
 * @returns {void}
 */
function restoreSavedPlan(event) {
  const button = event.target.closest('.saved-plan');
  if (!button) return;
  const plan = savedPlanRecords.find((record) => record.id === button.dataset.planId);
  if (!plan) return;
  document.querySelector('#event-type').value = plan.eventType;
  document.querySelector('#guest-count').value = plan.guestCount;
  document.querySelector('#budget').value = plan.budget;
  document.querySelector('#event-date').value = plan.eventDate || '';
  latestPlan = plan;
  renderPlan(plan.plan, plan.budget);
  prepareGoogleLinks(plan);
  planResults.hidden = false;
  savePlanResult.textContent = 'Saved plan restored.';
}

savePlanButton?.addEventListener('click', saveCurrentPlan);
loadPlansButton?.addEventListener('click', loadSavedPlans);
savedPlans?.addEventListener('click', restoreSavedPlan);

/* ── Rendering Helpers ───────────────────────────────────── */

/**
 * Escapes dynamic text before placing it into the result cards.
 * @param {*} value - Value to escape.
 * @returns {string} Safe HTML text.
 */
function escHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[character]));
}

/**
 * Renders the generated budget, timeline, checklist, and ideas.
 * @param {{budgetBreakdown: Array, timeline: Array, vendorChecklist: Array, ideas: Array}} plan - Plan data.
 * @param {number} budget - Total budget.
 * @returns {void}
 */
function renderPlan(plan, budget) {
  document.querySelector('#budget-breakdown').innerHTML = plan.budgetBreakdown.map((item) => `
    <div class="budget-item"><div><strong>${escHtml(item.name)}</strong><span>${item.percentage}%</span></div>
    <div class="budget-track"><span style="width: ${item.percentage}%"></span></div><b>${item.amount.toLocaleString()}</b></div>
  `).join('');
  document.querySelector('#timeline-list').innerHTML = plan.timeline.map((item) => `
    <li><strong>${escHtml(item.milestone)}</strong><span>${escHtml(item.date ? `${item.timing} · ${item.date}` : item.timing)}</span></li>
  `).join('');
  document.querySelector('#checklist').innerHTML = plan.vendorChecklist.map((item) => `
    <label class="check-item"><input type="checkbox" /> <span>${escHtml(item.task)}</span></label>
  `).join('');
  document.querySelector('#ideas-list').innerHTML = plan.ideas.map((item) => `
    <li>${escHtml(item.idea)} <small>${escHtml(item.fit)}</small></li>
  `).join('');
}
