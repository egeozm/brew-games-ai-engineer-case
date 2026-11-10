// LLM agent, version 1 (before the error-analysis fix). Provider: GEMINI_API_KEY -> Gemini, ANTHROPIC_API_KEY -> Claude, else local Ollama.
// Optional: LLM_PROVIDER (gemini|anthropic|ollama), LLM_MODEL.
//   node run.js --bot bots/llm_v1.js --games 30 --seed 1 --log logs/
'use strict';
const { createAgent } = require('./lib/agent.js');
const agent = createAgent({ name: 'llm_v1' });
module.exports = agent;
