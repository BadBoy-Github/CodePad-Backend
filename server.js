const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = '0.0.0.0';

// Ensure Java binaries are in PATH
process.env.PATH = '/usr/lib/jvm/java-11-openjdk/bin:' + process.env.PATH;
console.log('PATH:', process.env.PATH);

// Store active processes
const activeProcesses = new Map();

let processCounter = 0;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Execute Java code - Start execution
app.post('/execute/java/start', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'No code provided' });
    }

    const processId = ++processCounter;
    const timestamp = Date.now();
    const fileName = `Main_${timestamp}.java`;
    const className = `Main_${timestamp}`;
    const filePath = path.join(tempDir, fileName);
    const outDir = path.join(tempDir, `out_${timestamp}`);

    let javaProcess = null;
    let outputBuffer = '';
    let isFinished = false;

    try {
        // Create output directory
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Ensure the class name matches the file name
        let javaCode = code;
        // If the code has a package declaration, remove it for temporary execution
        javaCode = javaCode.replace(/package\s+[\w.]+;/g, '').trim();

        // If no class name matches the file, wrap the code or rename class
        const classMatch = javaCode.match(/class\s+(\w+)/);
        if (classMatch) {
            const originalClassName = classMatch[1];
            if (originalClassName !== className) {
                // Rename the class to match our filename
                javaCode = javaCode.replace(
                    new RegExp(`class\\s+${originalClassName}`, 'g'),
                    `class ${className}`
                );
            }
        }

        // Write the Java code to file
        fs.writeFileSync(filePath, javaCode, 'utf8');

        // Compile the Java code
        await new Promise((resolve, reject) => {
            execSync(`javac -d "${outDir}" "${filePath}"`, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(true);
            });
        });
        console.log('Compilation successful for', filePath);

        console.log('Spawning java with -cp', outDir, className);
        // Start the Java process with interactive stdin
        javaProcess = spawn('/usr/lib/jvm/java-11-openjdk/bin/java', ['-cp', outDir, className], {
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Store process info
        activeProcesses.set(processId, {
            process: javaProcess,
            outDir,
            filePath,
            isFinished: false,
            outputBuffer: ''
        });

        // Capture stdout
        javaProcess.stdout.on('data', (data) => {
            const text = data.toString();
            outputBuffer += text;
            const processInfo = activeProcesses.get(processId);
            if (processInfo) {
                processInfo.outputBuffer += text;
            }
        });

        // Capture stderr
        javaProcess.stderr.on('data', (data) => {
            const text = data.toString();
            outputBuffer += `Error: ${text}`;
            const processInfo = activeProcesses.get(processId);
            if (processInfo) {
                processInfo.outputBuffer += `Error: ${text}`;
            }
        });

        // Handle process error
        javaProcess.on('error', (err) => {
            outputBuffer += `Error: ${err.message}`;
            isFinished = true;
            const processInfo = activeProcesses.get(processId);
            if (processInfo) {
                processInfo.isFinished = true;
            }
        });

        // Handle process completion
        javaProcess.on('close', (code) => {
            isFinished = true;
            const processInfo = activeProcesses.get(processId);
            if (processInfo) {
                processInfo.isFinished = true;
            }
        });

        // Give it a moment to start and get initial output
        await new Promise(resolve => setTimeout(resolve, 100));

        // Get initial output
        let initialOutput = outputBuffer;

        console.log('Initial output:', JSON.stringify(initialOutput));
        console.log('isFinished:', isFinished);

        // Determine if program is waiting for input
        // If output doesn't end with newline, it's likely waiting for input
        const requiresInput = !isFinished && !initialOutput.endsWith('\n') && !initialOutput.endsWith('\r');

        // Check if process already finished (for non-interactive programs)
        if (javaProcess.exitCode !== null && !javaProcess.pid) {
            isFinished = true;
            const processInfo = activeProcesses.get(processId);
            if (processInfo) {
                processInfo.isFinished = true;
            }

            // Clean up
            try {
                fs.unlinkSync(filePath);
                fs.rmSync(outDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }

            activeProcesses.delete(processId);
        }

        res.json({
            success: true,
            processId,
            output: initialOutput || '',
            isFinished: false,
            requiresInput
        });

    } catch (error) {
        // Clean up on error
        try {
            if (javaProcess) {
                javaProcess.kill();
            }
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError);
        }

        res.status(400).json({
            success: false,
            error: error.message || 'Execution failed'
        });
    }
});

// Send input to running Java process
app.post('/execute/java/input', async (req, res) => {
    const { processId, input } = req.body;

    if (!processId || input === undefined) {
        return res.status(400).json({ error: 'Process ID and input required' });
    }

    const processInfo = activeProcesses.get(processId);

    if (!processInfo) {
        return res.status(400).json({ error: 'Process not found or already finished' });
    }

    if (processInfo.isFinished) {
        return res.status(400).json({ error: 'Process already finished' });
    }

    try {
        // Save output BEFORE writing input (this is where the prompt is)
        const outputBeforeInput = processInfo.outputBuffer;

        // Write input to stdin
        processInfo.process.stdin.write(input + '\n');

        // Debug: Log what we sent
        console.log('Input sent:', input);

        // Wait longer for output to fully accumulate
        await new Promise(resolve => setTimeout(resolve, 300));

        // Get the full output after input was processed
        const fullOutput = processInfo.outputBuffer;

        // Build formatted output: old output + user input + new output that came after input
        let formattedOutput = '';

        if (input && input.trim()) {
            // Get the new output that was produced after we sent input
            const newOutput = fullOutput.slice(outputBeforeInput.length);
            // Combine: old output + user input + new output
            formattedOutput = outputBeforeInput + input + '\n' + newOutput;
        } else {
            formattedOutput = outputBeforeInput;
        }

        // Return formatted output
        const output = formattedOutput;

        // Check if process is still running
        let requiresInput = false;

        if (processInfo.process.exitCode !== null) {
            processInfo.isFinished = true;

            // Clean up
            try {
                fs.unlinkSync(processInfo.filePath);
                fs.rmSync(processInfo.outDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error('Cleanup error:', cleanupError);
            }

            activeProcesses.delete(processId);
        } else {
            // Process is still running - check if it's waiting for more input
            // Check if the FULL output ends with a newline - if not, it's likely waiting for input
            const trimmedOutput = fullOutput.trimEnd();
            requiresInput = !trimmedOutput.endsWith('\n') && !trimmedOutput.endsWith('\r');
        }

        res.json({
            success: true,
            output,
            isFinished: processInfo.isFinished,
            requiresInput
        });

    } catch (error) {
        res.status(400).json({
            success: false,
            error: error.message || 'Failed to send input'
        });
    }
});

// Get output from running process
app.get('/execute/java/output/:processId', async (req, res) => {
    const { processId } = req.params;
    const processInfo = activeProcesses.get(parseInt(processId));

    if (!processInfo) {
        return res.status(400).json({ error: 'Process not found' });
    }

    res.json({
        success: true,
        output: processInfo.outputBuffer,
        isFinished: processInfo.isFinished,
        requiresInput: !processInfo.isFinished
    });
});

// Helper function for sync exec (needed for compilation)
function execSync(command, callback) {
    const { exec } = require('child_process');
    exec(command, { timeout: 10000 }, callback);
}

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, HOST, () => {
    console.log(`CodePad Backend Server running on http://${HOST}:${PORT}`);
    console.log(`Java execution endpoints:`);
    console.log(`  POST http://${HOST}:${PORT}/execute/java/start - Start execution`);
    console.log(`  POST http://${HOST}:${PORT}/execute/java/input - Send input`);
    console.log(`  GET http://${HOST}:${PORT}/execute/java/output/:processId - Get output`);
});