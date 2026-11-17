const Alexa = require('ask-sdk-core');
const API = process.env.BLKBOX_API_URL || '';
const skillId = process.env.ALEXA_SKILL_ID || '';

async function getJson(path) {
  if (!API.startsWith('https://')) throw new Error('BLKBOX_API_URL must be HTTPS');
  const response = await fetch(API.replace(/\/$/, '') + path, { signal: AbortSignal.timeout(4500) });
  if (!response.ok) throw new Error('BLKBOX radar unavailable');
  return response.json();
}
const say = (handlerInput, message) => handlerInput.responseBuilder.speak(message).getResponse();
const WhatWasThatHandler = {
  canHandle(input) {
    return Alexa.getRequestType(input.requestEnvelope) === 'LaunchRequest' ||
      Alexa.getIntentName(input.requestEnvelope) === 'WhatWasThatIntent';
  },
  async handle(input) {
    try {
      const data = await getJson('/api/v1/what-was-that');
      const craft = data.aircraft;
      if (!craft) return say(input, 'I did not receive an aircraft within fifteen nautical miles of the radar reference point in the past five minutes.');
      const name = craft.callsign || craft.icao;
      return say(input, `The most likely aircraft was ${name}, last received ${Math.round(craft.distanceNm * 10) / 10} nautical miles from the radar reference point, at ${craft.altitudeFt == null ? 'unknown altitude' : craft.altitudeFt + ' feet barometric altitude'}. This is not a confirmed identification.`);
    } catch {
      return say(input, 'Black Box airspace data is currently unavailable.');
    }
  }
};
const InterestingHandler = {
  canHandle(input) { return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(input.requestEnvelope) === 'AnythingInterestingIntent'; },
  async handle(input) {
    try {
      const data = await getJson('/api/v1/aircraft');
      const interesting = (data.aircraft || []).filter(a => (a.interestReasons || []).length).slice(0, 3);
      if (!interesting.length) return say(input, 'No aircraft currently in reception match the configured interest criteria.');
      const phrases = interesting.map(a => `${a.callsign || a.registration || a.icao}: ${a.interestReasons.map(r => r.label.toLowerCase()).join(', ')}`);
      return say(input, 'I see ${count} interesting aircraft. '.replace('${count}', String(interesting.length)) + phrases.join('. '));
    } catch { return say(input, 'Black Box airspace data is currently unavailable.'); }
  }
};
const HelpHandler = {
  canHandle(input) { return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' && Alexa.getIntentName(input.requestEnvelope) === 'AMAZON.HelpIntent'; },
  handle(input) { return say(input, 'Ask what plane was that, or ask whether anything interesting is nearby.'); }
};
const CancelHandler = {
  canHandle(input) { return Alexa.getRequestType(input.requestEnvelope) === 'IntentRequest' && ['AMAZON.StopIntent', 'AMAZON.CancelIntent'].includes(Alexa.getIntentName(input.requestEnvelope)); },
  handle(input) { return say(input, 'Goodbye.'); }
};
const ErrorHandler = { canHandle() { return true; }, handle(input) { return say(input, 'I cannot reach Black Box right now.'); } };
let builder = Alexa.SkillBuilders.custom().addRequestHandlers(WhatWasThatHandler, InterestingHandler, HelpHandler, CancelHandler).addErrorHandlers(ErrorHandler);
if (skillId) builder = builder.withSkillId(skillId);
exports.handler = builder.lambda();
