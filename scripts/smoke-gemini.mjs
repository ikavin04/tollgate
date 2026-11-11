import { GoogleGenAI, Type } from '@google/genai';

const apiKey = process.env.GEMINI_API_KEY?.trim();
const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3.5-flash-lite';

if (!apiKey) {
  console.error('Missing GEMINI_API_KEY in environment.');
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey });

async function run() {
  const started = Date.now();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: 'Return JSON confirming connectivity with status "ok" and the configured model name.',
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            status: { type: Type.STRING },
            model: { type: Type.STRING },
          },
          required: ['status', 'model'],
        },
        temperature: 0,
        maxOutputTokens: 128,
        abortSignal: AbortSignal.timeout(50_000),
      },
    });

    const elapsedMs = Date.now() - started;
    console.log(
      JSON.stringify(
        {
          ok: true,
          httpStatus: 200,
          configuredModel: model,
          modelVersion: response.modelVersion ?? null,
          responseId: response.responseId ?? null,
          elapsedMs,
          rawText: response.text?.trim() ?? null,
        },
        null,
        2
      )
    );
  } catch (err) {
    const elapsedMs = Date.now() - started;
    const status = err && typeof err === 'object' ? err.status ?? err.statusCode ?? null : null;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify(
        {
          ok: false,
          configuredModel: model,
          elapsedMs,
          httpStatus: status,
          error: message,
        },
        null,
        2
      )
    );
    process.exit(1);
  }
}

run();

