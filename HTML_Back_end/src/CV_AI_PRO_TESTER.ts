// To run this code you need to install the following dependencies:
// npm install @google/genai mime
// npm install -D @types/node

import {
    GoogleGenAI,
  } from '@google/genai';
  
  async function main() {
    const ai = new GoogleGenAI({apiKey: "AIzaSyCxacO9TqPYM1Dsq56ms_oZvze1fwvZcxU"});
    const config = {
      responseMimeType: 'text/plain',
    };
    const model = 'gemini-2.0-flash-lite';
    const contents = [
      {
        role: 'user',
        parts: [
          {
            text: `INSERT_INPUT_HERE`,
          },
        ],
      },
    ];
  
    const response = await ai.models.generateContentStream({
      model,
      config,
      contents,
    });
    for await (const chunk of response) {
      console.log(chunk.text);
    }
  }
  
  main();


//Coding moments, chill stream
