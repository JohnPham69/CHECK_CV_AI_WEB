// src/server.ts
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises'; // Use promises for async file operations
import os from 'os';
import { v4 as uuidv4 } from 'uuid'; // For unique temp directories
import { start_up } from './CV_AI_Processor'; // Import the processing function

// --- Configuration ---
const PORT = process.env.PORT || 5000;
const HOST = '127.0.0.1'; // Match Python backend host
const ALLOWED_EXTENSIONS = new Set(['pdf']); // Match Python backend
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB limit (example)
const MAX_CV_FILES = 100; // Arbitrary limit, adjust as needed

// --- Express App Setup ---
const app = express(); // <<<< IMPORTANT: Define the app object!

// Enable CORS - Allow requests from file:// or specific origins if needed
// For development, allowing all origins is often easiest.
app.use(cors()); // Allows all origins by default

// Middleware for parsing JSON and URL-encoded bodies (though Multer handles multipart)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Helper Functions ---

/**
 * Basic filename sanitization similar to Werkzeug's secure_filename.
 * Removes dangerous characters and path traversal attempts.
 * Important for security when using client-provided filenames on the server.
 */
const secureFilename = (filename: string): string => {
    if (!filename) return `file_${uuidv4()}.dat`; // Handle empty filenames

    // Normalize Unicode characters
    filename = filename.normalize('NFKD');

    // Remove leading/trailing whitespace and dots
    filename = filename.trim().replace(/^\.+|\.+$/g, '');

    // Replace invalid characters (anything not alphanumeric, underscore, hyphen, dot) with underscore
    // Keep '.', '_', '-'
    filename = filename.replace(/[^a-zA-Z0-9_.-]/g, '_');

    // Collapse multiple consecutive underscores/hyphens/dots
    filename = filename.replace(/([_.-])\1+/g, '$1');

    // Prevent path traversal components (replace '..')
    filename = filename.replace(/\.\.+/g, '_');

    // Ensure it doesn't start or end with problematic chars like '.' or '-'
    filename = filename.replace(/^[-._]+|[-._]+$/g, '');

    // Limit length to prevent excessively long filenames
    const maxLength = 200;
    if (filename.length > maxLength) {
        const ext = path.extname(filename);
        filename = filename.substring(0, maxLength - ext.length) + ext;
    }
    // Handle cases where filename becomes empty after sanitization
    if (!filename || filename === '.' || filename === '..') {
        return `secure_file_${uuidv4()}.dat`;
    }

    return filename;
};

/**
 * Checks if a filename has an allowed extension.
 */
const allowedFile = (filename: string): boolean => {
    const ext = path.extname(filename).toLowerCase();
    if (!ext) return false; // No extension
    return ALLOWED_EXTENSIONS.has(ext.substring(1)); // Remove leading '.' before checking
};

/**
 * Asynchronously removes a directory and its contents.
 * Logs errors but doesn't throw, allowing request handling to finish.
 */
async function cleanupTempDir(dirPath: string | undefined): Promise<void> {
    if (!dirPath) return;
    try {
        // Check if directory exists before attempting removal
        await fs.access(dirPath); // Throws if doesn't exist
        await fs.rm(dirPath, { recursive: true, force: true });
        console.log(`Successfully removed temporary server directory: ${dirPath}`);
    } catch (error: any) {
        // Log error if removal fails (e.g., permissions, file lock)
        // ENOENT (Not Found) is okay if it was already deleted or never created fully.
        if (error.code !== 'ENOENT') {
            console.error(`Error removing temporary server directory ${dirPath}: ${error.message}`);
        } else {
            // console.log(`Temporary directory ${dirPath} already removed or never existed.`);
        }
    }
}

// --- Multer Setup for File Uploads ---

// Define temporary storage strategy
const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        // Create a unique temporary directory *per request* on the server
        // Store the temp dir path on the request object for later access and cleanup
        const reqWithTempDir = req as Request & { tempDir?: string };
        if (!reqWithTempDir.tempDir) {
            // Generate unique directory name within the OS temp folder
            const tempDir = path.join(os.tmpdir(), `cv_scanner_ts_${uuidv4()}`);
            try {
                await fs.mkdir(tempDir, { recursive: true });
                reqWithTempDir.tempDir = tempDir; // Attach to request for later cleanup
                console.log(`Created temporary server directory: ${tempDir}`);
                cb(null, tempDir); // Tell multer where to save
            } catch (err: any) {
                console.error("Error creating temp directory:", err);
                cb(err, ''); // Pass error to multer
            }
        } else {
            cb(null, reqWithTempDir.tempDir); // Use existing dir for this request
        }
    },
    filename: (req, file, cb) => {
        // Sanitize the original filename from the client before saving on the server
        const originalName = file.originalname || `unknown_file_${uuidv4()}`;
        const secured = secureFilename(originalName);
        console.log(`  Saving ${file.fieldname} ('${originalName}') to temporary server path as '${secured}'`);
        cb(null, secured); // Use the sanitized filename
    }
});

// Configure Multer middleware
const upload = multer({
    storage: storage,
    fileFilter: (req, file, cb) => {
        // Validate file extension using our allowedFile function
        if (allowedFile(file.originalname)) {
            cb(null, true); // Accept file
        } else {
            console.log(`  Warning: Rejecting invalid file type: '${file.originalname}'. Allowed: ${Array.from(ALLOWED_EXTENSIONS).join(', ')}`);
            // Reject file - pass an error to stop the upload for this file specifically
            cb(new Error(`Invalid file type: '${path.extname(file.originalname)}'. Only ${Array.from(ALLOWED_EXTENSIONS).map(e => `.${e}`).join(', ')} allowed.`));
        }
    },
    limits: {
        fileSize: MAX_FILE_SIZE_BYTES, // Max size per file
        files: MAX_CV_FILES + 1 // Max total files (CVs + 1 criteria)
    }
});

// Middleware specifically for the expected fields ('criteriaFile' and 'cvFiles[]')
// These names MUST match the names used in App.html FormData.append()
const uploadFields = upload.fields([
    { name: 'criteriaFile', maxCount: 1 }, // Expect exactly one file named 'criteriaFile'
    { name: 'cvFiles[]', maxCount: MAX_CV_FILES } // Expect multiple files named 'cvFiles[]'
]);

// --- API Endpoint: /process ---
app.post('/process', (req: Request, res: Response, next: NextFunction) => {
    // 1. Use multer middleware first to handle file uploads and parsing form data
    uploadFields(req, res, async (err) => {
        // Get the temporary directory path attached by multer's 'destination' function
        // We need this for cleanup, regardless of success or failure
        const tempDir = (req as Request & { tempDir?: string }).tempDir;

        // --- Multer Error Handling ---
        // Check if Multer encountered an error during upload (e.g., file size, type, count)
        if (err) {
            console.error("Error during file upload (Multer):", err);
            await cleanupTempDir(tempDir); // Attempt cleanup even if upload failed partially
            if (err instanceof multer.MulterError) {
                // Handle specific multer errors (e.g., file size limit)
                return res.status(400).json({ error: `File upload error: ${err.message} (Code: ${err.code})` });
            } else if (err instanceof Error) {
                 // Handle errors from fileFilter (e.g., invalid file type) or storage creation
                 return res.status(400).json({ error: err.message });
            } else {
                // Handle other unexpected errors during upload phase
                return res.status(500).json({ error: "An unexpected error occurred during file upload." });
            }
        }

        // --- Request Handling Logic (after successful upload) ---
        try {
            console.log("\n--- New Request Received ---");
            const timestamp = new Date().toISOString();
            console.log(`Timestamp: ${timestamp}`);
            console.log("Received request on /process");

            // --- 2. Get Data from Request ---
            // Form fields (non-file data) are in req.body (parsed by multer alongside files)
            const { apiKey, modelName, maxRating, minRating } = req.body;
            // Files are in req.files (as an object keyed by fieldname)
            // Type assertion for better intellisense
            const files = req.files as { [fieldname: string]: Express.Multer.File[] | undefined };

            // Validate required form fields (basic checks, similar to Python)
            const formErrors: string[] = [];
            if (!apiKey) formErrors.push("API Key is missing");
            if (!modelName) formErrors.push("Model Name is missing");
            if (!maxRating) formErrors.push("Maximum Rating is missing");
            if (!minRating) formErrors.push("Minimum Rating is missing");
            // Add rating comparison check from App.html
            const maxR = parseInt(maxRating, 10);
            const minR = parseInt(minRating, 10);
            if (isNaN(maxR) || isNaN(minR)) {
                formErrors.push("Max/Min Rating must be numbers");
            } else if (minR >= maxR) {
                 formErrors.push("Minimum rating must be smaller than Maximum rating");
            }

            if (formErrors.length > 0) {
                await cleanupTempDir(tempDir); // Cleanup before sending error
                return res.status(400).json({ error: formErrors.join('. ') });
            }
            console.log(`Received Form Data: Model=${modelName}, MaxRating=${maxRating}, MinRating=${minRating}, APIKey=Present`);

            // --- 3. Validate and Access Files ---
            // Access files using the field names defined in uploadFields
            const criteriaFileArray = files?.['criteriaFile'];
            const cvFilesArray = files?.['cvFiles[]'];

            // Check if the required files were actually uploaded and received
            if (!criteriaFileArray || criteriaFileArray.length === 0) {
                await cleanupTempDir(tempDir);
                return res.status(400).json({ error: "Criteria file is missing or was not uploaded successfully." });
            }
            if (!cvFilesArray || cvFilesArray.length === 0) {
                await cleanupTempDir(tempDir);
                return res.status(400).json({ error: "No CV files were uploaded successfully." });
            }

            // Get the actual file objects from Multer
            const criteriaFile = criteriaFileArray[0]; // The single criteria file object
            const cvFiles = cvFilesArray; // The array of CV file objects

            // Get the *server-side temporary paths* where Multer saved the files
            const criteriaPath = criteriaFile.path;
            const cvPaths = cvFiles.map(file => file.path); // Get paths for all CVs

            console.log(`Criteria file saved to temporary server path: ${criteriaPath}`);
            console.log(`CV files (${cvPaths.length}) saved to temporary server paths.`); // Log count

            // --- 4. Prepare for Processing Script ---
            // Construct the user prompt string exactly as expected by the processing logic (start_up)
            // This matches the format in the Python backend
            const userPrompt = `\nMaximum rating score must be: ${maxRating}\nTo pass, the minimum score to pass must be: ${minRating}`;

            console.log("\nCalling processing script (CV_AI_Processor.start_up)...");
            console.log(`  Criteria Path (Server Temp): ${criteriaPath}`); // Log full path now
            console.log(`  CV Paths (Server Temp Count): ${cvPaths.length}`);
            console.log(`  Model: ${modelName}`);
            console.log(`  User Prompt: ${userPrompt.replace(/\n/g, ' ')}`); // Print prompt on one line

            // --- 5. Call the Processing Script ---
            // Pass the server-side temporary paths and other data to the imported start_up function
            // Ensure start_up is async if it performs async operations (like API calls or file I/O)
            const resultText = await start_up(
                criteriaPath,
                cvPaths,
                userPrompt,
                modelName,
                apiKey
            );

            console.log("Processing script finished.");
            // console.log(`Raw result:\n${resultText.substring(0, 200)}...`); // Log beginning of result

            // --- 6. Handle Response ---
            // Check if the result string indicates an error from the script itself (convention: starts with "ERROR:")
            if (resultText.trim().toUpperCase().startsWith("ERROR:")) {
                 console.error(`Processing script returned an error: ${resultText}`);
                 let statusCode = 500; // Default to internal server error
                 const upperResult = resultText.toUpperCase();
                 // Check for keywords indicating potential client-side issues (API key, model, input file errors)
                 // to return a 400 Bad Request instead of 500 Internal Server Error
                 if (upperResult.includes("API KEY") || upperResult.includes("NOT FOUND") || upperResult.includes("MODEL") || upperResult.includes("INVALID") || upperResult.includes("MISSING") || upperResult.includes("COULD NOT READ")) {
                     statusCode = 400; // Bad input from user or issue processing their specific files/config
                 }
                 // Cleanup happens in the finally block
                 return res.status(statusCode).json({ error: resultText }); // Send error back to frontend
            } else {
                // Success
                console.log("Processing successful. Sending result to frontend.");
                // Cleanup happens in the finally block
                return res.status(200).json({ result: resultText }); // Send success result back to frontend
            }

        } catch (error: any) {
            // Catch any unexpected errors during request handling *after* upload but *before* sending response
            console.error(`An unexpected error occurred in /process endpoint handler: ${error.message}`, error.stack);
            // Cleanup happens in the finally block
            return res.status(500).json({ error: `An internal server error occurred: ${error.message}` });
        } finally {
            // --- 7. Clean Up Temporary Files ---
            // This 'finally' block ensures cleanup runs whether the try block succeeded or failed
            await cleanupTempDir(tempDir); // Call cleanup function
            console.log("--- Request Handling Finished ---");
        }
    }); // End of multer middleware callback
}); // End of app.post('/process')

// --- Global Error Handler (Optional but Recommended) ---
// Catches errors not handled in specific routes
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error("Unhandled application error:", err.stack);
    // Avoid sending detailed stack traces to the client in production
    res.status(500).json({ error: 'An unexpected internal server error occurred.' });
});

// --- Start Server ---
app.listen(5000, HOST, () => {
    console.log(`Server listening on http://${HOST}:5000`);
    console.log("Allowed file extensions:", Array.from(ALLOWED_EXTENSIONS));
    console.log("Make sure the frontend (App.html) sends requests to this address.");
    console.log("Press Ctrl+C to stop the server.");
});
