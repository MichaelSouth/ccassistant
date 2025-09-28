import { azure } from "@ai-sdk/azure";
import { streamText, UIMessage, convertToModelMessages, UIMessagePart } from "ai";

import { NextRequest } from "next/server";

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

  // Map UIMessage[] → Azure format: { role, content }
  const azureMessages = messages.map(msg => {
    // Concatenate all text parts into one string for this message
    const content = msg.parts
      ?.filter(p => p.type === "text")
      .map(p => (p as any).text)
      .join("\n")
      .trim() || "";

    return {
      role: msg.role, // "user" | "assistant"
      content,
    };
  });

  const requestBody = {
    messages: azureMessages,
    max_tokens: 4096,
    temperature: 0.7,
    top_p: 0.95,
    frequency_penalty: 0,
    presence_penalty: 0,
    dataSources: [
      {
        type: "AzureCognitiveSearch",
        parameters: {
          endpoint: process.env.AZURE_SEARCH_ENDPOINT, // e.g. "https://mysearch.search.windows.net"
          key: process.env.AZURE_SEARCH_KEY,           // your Cognitive Search admin/query key
          indexName: process.env.AZURE_SEARCH_INDEX,   // index name
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

  const json = await response.json();
  console.log("Azure messages:", json);
  
  // Extract the assistant’s text like you did in C#
  const content = json?.choices?.[0]?.message?.content?.trim() ?? "No response from AI.";

  console.log("Extarcted Azure message:", content);

  //return result
  const encoder = new TextEncoder();
  const uiMessageId = "0";
  const stream = new ReadableStream({
    start(controller) {
      const events = [
        { type: "start" },
        { type: "start-step" },
        { type: "text-start", id: uiMessageId },
        { type: "text-delta", id: uiMessageId, delta: content },
        { type: "text-end", id: uiMessageId },
        { type: "finish-step" },
        { type: "finish" },
      ];

      for (const event of events) {
        const chunk = `data: ${JSON.stringify(event)}\n\n`;
        controller.enqueue(encoder.encode(chunk));
      }

      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
};

