require('dotenv').config();

const fs = require('fs');

async function listActiveModels() {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
  const data = await response.json();
  if (data.models) {
    const generateModels = data.models.filter(m => m.supportedGenerationMethods.includes('generateContent'));
    const output = generateModels.map(m => m.name).join('\n');
    fs.writeFileSync('available-models.txt', output);
    console.log(`Written ${generateModels.length} models to available-models.txt`);
  } else {
    fs.writeFileSync('available-models.txt', JSON.stringify(data, null, 2));
    console.log("Error response written to available-models.txt");
  }
}

listActiveModels();
