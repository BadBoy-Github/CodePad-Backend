const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Ensure temp directory exists
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
}

// Execute Java code
app.post('/execute/java', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'No code provided' });
    }

    const timestamp = Date.now();
    const fileName = `Main_${timestamp}.java`;
    const className = `Main_${timestamp}`;
    const filePath = path.join(tempDir, fileName);
    const outDir = path.join(tempDir, `out_${timestamp}`);

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
        const compileCommand = `javac -d "${outDir}" "${filePath}"`;

        await new Promise((resolve, reject) => {
            exec(compileCommand, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(true);
            });
        });

        // Execute the compiled Java class
        const executeCommand = `java -cp "${outDir}" ${className}`;

        const executionResult = await new Promise((resolve, reject) => {
            exec(executeCommand, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(new Error(stderr || error.message));
                    return;
                }
                resolve(stdout);
            });
        });

        // Clean up
        try {
            fs.unlinkSync(filePath);
            fs.rmSync(outDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError);
        }

        res.json({
            success: true,
            output: executionResult || 'Code executed successfully (no output)'
        });

    } catch (error) {
        // Clean up on error
        try {
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

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`CodePad Backend Server running on http://localhost:${PORT}`);
    console.log(`Java execution endpoint: POST http://localhost:${PORT}/execute/java`);
});