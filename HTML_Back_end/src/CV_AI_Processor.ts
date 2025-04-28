// src/CV_AI_Processor.ts
import fs from 'fs/promises';
import path from 'path';
// Corrected import based on your provided files
import {
    GoogleGenerativeAI, // Use GoogleGenerativeAI for initialization
    HarmCategory,       // Keep for reference if needed later, but not used now
    HarmBlockThreshold, // Keep for reference if needed later, but not used now
    Part,
    GenerateContentRequest // Useful for typing the request structure
} from "@google/generative-ai"; // Assuming this is the correct package based on previous context

// Helper function to convert a file path to a Generative Part for the API
// Reads the file, determines MIME type (assuming PDF here), and encodes data
async function fileToGenerativePart(filePath: string): Promise<Part> {
    console.log(`  Reading file for API: ${filePath}`);
    const fileData = await fs.readFile(filePath);
    const base64EncodedData = fileData.toString('base64');
    // Simple MIME type detection based on extension - adjust if needed
    const mimeType = path.extname(filePath).toLowerCase() === '.pdf' ? 'application/pdf' : 'application/octet-stream'; // Default if not PDF

    if (mimeType !== 'application/pdf') {
        console.warn(`  Warning: File ${path.basename(filePath)} is not a PDF. Using generic MIME type.`);
    }

    return {
        inlineData: {
            mimeType,
            data: base64EncodedData,
        },
    };
}


// Main processing function - uses generateContentStream
export async function start_up(
    path_to_crit: string, // Server-side temporary path to criteria PDF
    path_to_CVs: string[], // Array of server-side temporary paths to CV PDFs
    user_prompt_from_frontend: string, // The string containing min/max ratings from App.html
    modelName: string, // The AI model name (e.g., "gemini-1.5-flash-latest")
    apiKey: string // The Google AI API Key passed from server.ts
): Promise<string> { // Return the result string or an error string

    console.log("--- Inside REAL start_up (CV_AI_Processor.ts) ---");

    // --- 1. Input Validation ---
    if (!apiKey) {
        return "ERROR: API Key was not provided to the processing function.";
    }
    if (!path_to_crit) {
        return "ERROR: Criteria file path is missing.";
    }
    if (!path_to_CVs || path_to_CVs.length === 0) {
        return "ERROR: CV file paths are missing.";
    }
    console.log(`Processing ${path_to_CVs.length} CV(s) against criteria: ${path.basename(path_to_crit)}`);

    // --- 2. Construct the Prompt (mimicking Python's 'thebot') ---
    const fullPrompt = `You are the CV Checker and evaluate bot.
Analyze **all** CVs based on the provided criteria PDF.
You will be given at least 2 file. Only one of them is the criteria file, find the Criteria file before evaluation.
- Remention the criteria file which was given to you.
- Each CV is a separate PDF file provided alongside this prompt.
- Show the name of the applicant right next to each CV.
- Provide a score for **each** CV (e.g., 9/10 or 3/4, respecting the max score below).
- If the score meets or exceeds the passing rate specified below, the applicant **passes**.
- State clearly for each applicant: "I [agree/disagree] on accepting the applicant [# if multiple CVs]."
- List reasons for the decision using "- " bullet points.
- If the CV **passes**, suggest at least 3 relevant interview questions based on the CV and criteria.
- Count and display the **total number of CVs** analyzed at the end.

User requirements from frontend:
${user_prompt_from_frontend}
`;

    console.log("Constructed Prompt (first 100 chars):", fullPrompt.substring(0, 100) + "...");
    console.log("Model to use:", modelName);

    try {
        // --- 3. Initialize Google AI ---
        // Use GoogleGenerativeAI for initialization
        const genAI = new GoogleGenerativeAI(apiKey);

        // --- 4. Prepare File Parts for API ---
        console.log("Preparing files for Google AI API...");
        // Check file existence before reading
        try {
            await fs.access(path_to_crit);
        } catch (accessError) {
            console.error(`Error accessing criteria file: ${path_to_crit}`, accessError);
            return `ERROR: Criteria file not found or inaccessible at temporary path: ${path.basename(path_to_crit)}`;
        }
        const criteriaFilePart = await fileToGenerativePart(path_to_crit);

        const cvFileParts: Part[] = [];
        for (const cvPath of path_to_CVs) {
            try {
                await fs.access(cvPath);
            } catch (accessError) {
                 console.error(`Error accessing CV file: ${cvPath}`, accessError);
                 return `ERROR: CV file not found or inaccessible at temporary path: ${path.basename(cvPath)}`;
            }
            cvFileParts.push(await fileToGenerativePart(cvPath));
        }
        console.log(`Prepared ${cvFileParts.length + 1} file parts for API.`);

        // Combine prompt text and all file parts into the correct structure for 'contents'
        // Ensure ALL elements are valid 'Part' objects
        const requestParts: Part[] = [ // <<<< Ensure type is Part[]
            { text: fullPrompt },      // <<<< Wrap the string prompt in a text Part object
            criteriaFilePart,
            ...cvFileParts
        ];

        // Define the 'contents' structure using the prepared parts
        // The type assertion GenerateContentRequest['contents'] is still valid
        const contentsForApi: GenerateContentRequest['contents'] = [{ role: "user", parts: requestParts }];


        // --- 5. Configure and Call Google AI Model using Streaming ---
        const model = genAI.getGenerativeModel({ model: modelName });

        // Define generation config (including responseMimeType from tester)
        const generationConfig = {
            temperature: 1,
            topP: 0.95,
            topK: 64,
            maxOutputTokens: 8192,
            responseMimeType: "text/plain", // Added based on tester
        };

        // Safety settings are removed as requested

        console.log(`Calling Google AI model (${modelName}) via stream...`);

        // Call generateContentStream
        const streamResult = await model.generateContentStream({
            contents: contentsForApi, // This should now be correct
            generationConfig,
            // safetySettings, // Removed
        });

        // --- 6. Process the Stream ---
        let streamedText = '';
        // Iterate over the stream using response.stream
        for await (const chunk of streamResult.stream) {
            // Use the text() method to get text from the chunk
            const chunkText = chunk.text?.();
            if (chunkText) {
                streamedText += chunkText;
                // Optional: Log progress if needed
                // console.log("Received chunk:", chunkText.substring(0, 50) + "...");
            } else {
                // Optional: Log if a chunk doesn't contain text
                // console.log("Received non-text chunk or empty text chunk.");
            }
        }

        // Check if any text was accumulated after the stream finished
        if (!streamedText || streamedText.trim() === '') {
             console.error("Google AI stream finished but produced no text content.");
             // You might want to check streamResult.response for promptFeedback if available
             const feedback = await streamResult.response;
             const blockReason = feedback?.promptFeedback?.blockReason;
             console.error("Stream Response Feedback:", feedback?.promptFeedback);
             let errorMsg = "ERROR: Google AI returned an empty stream result.";
              if (blockReason) {
                 errorMsg += ` Reason: ${blockReason}.`;
             }
             return errorMsg;
        }

        const aiResultText = streamedText; // Assign accumulated text

        console.log("Finished processing stream from Google AI.");

        // Prepend the "Powered by" string
        const finalResult = `Powered by ${modelName}\n\n${aiResultText}`;

        return finalResult;

    } catch (error: any) {
        console.error("Error during Google AI API call or file processing:", error);

        // Error handling remains largely the same
        const errorMessage = error.message?.toLowerCase() || '';

        if (errorMessage.includes('api key not valid') || errorMessage.includes('permission_denied') || errorMessage.includes('authentication failed')) {
             return `ERROR: Invalid or incorrect Google AI API Key. Please check the key. Details: ${error.message}`;
        }
        if (errorMessage.includes('quota') || errorMessage.includes('resource has been exhausted')) {
             return `ERROR: Google AI API quota exceeded or resource exhausted. Details: ${error.message}`;
        }
        if (errorMessage.includes('model not found') || errorMessage.includes('invalid model name')) {
             return `ERROR: Google AI Model '${modelName}' not found or is invalid. Details: ${error.message}`;
        }
        if (errorMessage.includes('file size') || errorMessage.includes('file processing failed')) {
             return `ERROR: Problem processing uploaded files with Google AI. Details: ${error.message}`;
        }
        if (error.code === 'ENOENT') { // File system error from fs.readFile/fs.access
             return `ERROR: Could not read temporary file: ${error.path}. File system error.`;
        }

        // General error
        return `ERROR: Failed during AI processing. Details: ${error.message}`;
    }
}
