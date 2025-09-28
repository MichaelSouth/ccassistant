import { NextRequest } from "next/server";
import { UIMessage } from "ai";

export async function POST(req: NextRequest) {
  const { messages }: { messages: UIMessage[] } = await req.json();

   // Log the incoming messages for debugging
  console.log("Incoming messages from assistant-ui:");
  messages.forEach((msg, i) => {
    console.log(`Message ${i} | id: ${msg.id} | role: ${msg.role}`);
    if (msg.parts && msg.parts.length > 0) {
      msg.parts.forEach((part, j) => {
        console.log(`  Part ${j} | type: ${part.type} | text: ${(part as any).text}`);
      });
    } else {
      console.log("  No parts found");
    }
  });

  // Map UIMessage[] → Azure format
  const azureMessages = messages.map(msg => ({
    role: msg.role,
    content: msg.parts?.filter(p => p.type === "text").map(p => (p as any).text).join("\n") ?? ""
  }));

  const requestBody = {
    messages: azureMessages,
    max_tokens: 4096,
    temperature: 0.7,
    top_p: 0.95,
    frequency_penalty: 0,
    presence_penalty: 0,
    stream: true, // enable streaming
    dataSources: [
      {
        type: "AzureCognitiveSearch",
        parameters: {
          endpoint: process.env.AZURE_SEARCH_ENDPOINT,
          key: process.env.AZURE_SEARCH_KEY,
          indexName: process.env.AZURE_SEARCH_INDEX,
        },
      },
    ],
  };

  const response = await fetch(
    `https://${process.env.AZURE_OPENAI_ENDPOINT}/openai/deployments/${process.env.AZURE_OPENAI_DEPLOYMENT}/extensions/chat/completions?api-version=2023-08-01-preview`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": process.env.AZURE_OPENAI_API_KEY!,
      },
      body: JSON.stringify(requestBody),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    console.error("Error response from Azure OpenAI:", errText);
    return new Response(`Error: ${response.status} - ${errText}`, { status: 500 });
  }

  console.log("Azure OpenAI response status:", response.status);

  const encoder = new TextEncoder();
  const uiMessageId = crypto.randomUUID();

  // Create a ReadableStream to forward chunks as they arrive
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start" })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "start-step" })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text-start", id: uiMessageId })}\n\n`));

      // Read the response body as a stream
      const reader = response.body?.getReader();
      if (!reader) {
        controller.close();
        return;
      }

      let decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        console.log("Looping to read stream...");

        const { done, value } = await reader.read();
        if (done) {
          console.log("All lines read");
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Azure streams SSE lines like `data: {...}\n\n`
        const lines = buffer.split("\n\n");
        buffer = lines.pop() ?? ""; // keep the last incomplete line

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.replace(/^data: /, "").trim();
            if (data === "[DONE]") continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.choices?.[0]?.delta?.content) {
                const chunkEvent = {
                  type: "text-delta",
                  id: uiMessageId,
                  delta: parsed.choices[0].delta.content,
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunkEvent)}\n\n`));
              }
            }  catch (err) {
              // Log the full error object for precise information
              console.error("Error parsing line:", line, "\nError details:", err);
            }
          }
        }
      }

      console.log("Close stream");
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "text-end", id: uiMessageId })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish-step" })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "finish" })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}
