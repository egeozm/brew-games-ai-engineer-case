// LLM agent, final version (v2). Identical to llm_v1.js except ONE change chosen by the error analysis
// (part2/NOTE.md): v1 lost 22 of 30 games by setting then_fight=true and walking into a battle its own
// preview would have shown as lost. In v2, then_fight only starts the battle if the game's simulator
// predicts a win; otherwise the model gets the preview back and must fix the bag or call fight() deliberately.
// Provider: GEMINI_API_KEY -> Gemini, ANTHROPIC_API_KEY -> Claude, else local Ollama (LLM_PROVIDER / LLM_MODEL override).
//   node run.js --bot bots/llm.js --games 30 --seed 1 --log logs/
'use strict';
const { createAgent } = require('./lib/agent.js');
module.exports = createAgent({ name: 'llm_v2', guardThenFight: true });
