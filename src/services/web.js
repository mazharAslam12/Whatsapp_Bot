const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const QR_PATH = path.join(process.cwd(), "user_files", "login-qr.png");

function startWebServer() {
    const server = http.createServer((req, res) => {
        if (req.url === "/qr") {
            if (fs.existsSync(QR_PATH)) {
                res.writeHead(200, { "Content-Type": "image/png" });
                fs.createReadStream(QR_PATH).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("QR code not generated yet. Please wait or check bot logs.");
            }
        } else if (req.url === "/download-qr") {
            if (fs.existsSync(QR_PATH)) {
                res.writeHead(200, { 
                    "Content-Type": "image/png",
                    "Content-Disposition": 'attachment; filename="Mazhar_DevX_Login_QR.png"'
                });
                fs.createReadStream(QR_PATH).pipe(res);
            } else {
                res.writeHead(404, { "Content-Type": "text/plain" });
                res.end("QR code not found.");
            }
        } else {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Mazhar DevX • Login</title>
                    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
                    <style>
                        :root {
                            --bg-color: #050505;
                            --primary-color: #00f2fe;
                            --secondary-color: #4facfe;
                            --text-main: #ffffff;
                            --text-muted: #a0a0ab;
                            --card-bg: rgba(255, 255, 255, 0.03);
                            --card-border: rgba(255, 255, 255, 0.05);
                        }
                        * {
                            box-sizing: border-box;
                            margin: 0;
                            padding: 0;
                            font-family: 'Outfit', sans-serif;
                        }
                        body {
                            background-color: var(--bg-color);
                            color: var(--text-main);
                            min-height: 100vh;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            padding: 20px;
                            background-image: 
                                radial-gradient(circle at 15% 50%, rgba(79, 172, 254, 0.15), transparent 25%),
                                radial-gradient(circle at 85% 30%, rgba(0, 242, 254, 0.15), transparent 25%);
                            overflow: hidden;
                        }
                        .container {
                            max-width: 480px;
                            width: 100%;
                            background: var(--card-bg);
                            border: 1px solid var(--card-border);
                            border-radius: 24px;
                            padding: 40px;
                            backdrop-filter: blur(20px);
                            -webkit-backdrop-filter: blur(20px);
                            box-shadow: 0 30px 60px rgba(0, 0, 0, 0.4),
                                        inset 0 1px 0 rgba(255, 255, 255, 0.1);
                            text-align: center;
                            position: relative;
                            animation: slideUp 0.6s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                            opacity: 0;
                            transform: translateY(20px);
                        }
                        @keyframes slideUp {
                            to { opacity: 1; transform: translateY(0); }
                        }
                        .brand {
                            font-size: 1.5rem;
                            font-weight: 800;
                            margin-bottom: 8px;
                            background: linear-gradient(135deg, var(--secondary-color), var(--primary-color));
                            -webkit-background-clip: text;
                            -webkit-text-fill-color: transparent;
                            letter-spacing: -0.5px;
                        }
                        .subtitle {
                            color: var(--text-muted);
                            font-size: 0.95rem;
                            margin-bottom: 32px;
                            font-weight: 300;
                        }
                        .qr-wrapper {
                            position: relative;
                            width: 260px;
                            height: 260px;
                            margin: 0 auto 30px;
                            background: white;
                            border-radius: 16px;
                            padding: 12px;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            box-shadow: 0 0 40px rgba(79, 172, 254, 0.2);
                            transition: transform 0.3s ease, box-shadow 0.3s ease;
                        }
                        .qr-wrapper:hover {
                            transform: translateY(-5px);
                            box-shadow: 0 10px 50px rgba(79, 172, 254, 0.3);
                        }
                        .qr-image {
                            width: 100%;
                            height: 100%;
                            object-fit: cover;
                            border-radius: 8px;
                            opacity: 0;
                            transition: opacity 0.5s ease;
                        }
                        .qr-placeholder {
                            position: absolute;
                            inset: 0;
                            display: flex;
                            flex-direction: column;
                            align-items: center;
                            justify-content: center;
                            color: #888;
                        }
                        .spinner {
                            width: 30px;
                            height: 30px;
                            border: 3px solid rgba(0,0,0,0.1);
                            border-top-color: #4facfe;
                            border-radius: 50%;
                            animation: spin 1s linear infinite;
                            margin-bottom: 10px;
                        }
                        @keyframes spin { 
                            to { transform: rotate(360deg); } 
                        }
                        .btn {
                            display: inline-flex;
                            align-items: center;
                            justify-content: center;
                            gap: 8px;
                            background: linear-gradient(135deg, var(--secondary-color) 0%, var(--primary-color) 100%);
                            color: #000;
                            text-decoration: none;
                            padding: 14px 28px;
                            border-radius: 12px;
                            font-weight: 600;
                            font-size: 1rem;
                            transition: all 0.3s ease;
                            border: none;
                            cursor: pointer;
                            width: 100%;
                            box-shadow: 0 4px 15px rgba(0, 242, 254, 0.2);
                        }
                        .btn:hover {
                            transform: translateY(-2px);
                            box-shadow: 0 8px 25px rgba(0, 242, 254, 0.3);
                        }
                        .btn:active {
                            transform: translateY(1px);
                        }
                        .btn svg {
                            width: 18px;
                            height: 18px;
                        }
                        .footer-text {
                            margin-top: 24px;
                            font-size: 0.8rem;
                            color: var(--text-muted);
                            opacity: 0.6;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="brand">Mazhar DevX</div>
                        <div class="subtitle">Secure WhatsApp Authentication</div>
                        
                        <div class="qr-wrapper">
                            <div class="qr-placeholder" id="qr-placeholder">
                                <div class="spinner"></div>
                                <span style="font-size: 0.9rem; font-weight: 600; color: #333">Waiting for QR...</span>
                            </div>
                            <img id="qr-img" class="qr-image" alt="WhatsApp QR Code" crossorigin="anonymous">
                        </div>

                        <a href="/download-qr" id="download-btn" class="btn" style="pointer-events: none; opacity: 0.7;">
                            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                            </svg>
                            Download QR Code
                        </a>
                        
                        <div class="footer-text">
                            Scan with your WhatsApp to connect <br>
                            QR auto-downloads when generated perfectly.
                        </div>
                    </div>

                    <script>
                        const qrImg = document.getElementById('qr-img');
                        const placeholder = document.getElementById('qr-placeholder');
                        const downloadBtn = document.getElementById('download-btn');
                        let downloaded = false;

                        function checkQR() {
                            fetch('/qr')
                                .then(response => {
                                    if (response.ok) {
                                        const src = '/qr?t=' + new Date().getTime(); // cache buster
                                        qrImg.src = src;
                                        
                                        qrImg.onload = () => {
                                            qrImg.style.opacity = '1';
                                            placeholder.style.display = 'none';
                                            
                                            // Enable download button
                                            downloadBtn.style.pointerEvents = 'auto';
                                            downloadBtn.style.opacity = '1';

                                            // Auto-download once
                                            if (!downloaded) {
                                                downloaded = true;
                                                // Trigger a top-level navigation to the download endpoint
                                                // which forces a download without replacing the current page in most browsers!
                                                window.location.href = "/download-qr";
                                                
                                                // Fallback iframe download method
                                                setTimeout(() => {
                                                    const iframe = document.createElement('iframe');
                                                    iframe.style.display = 'none';
                                                    iframe.src = "/download-qr";
                                                    document.body.appendChild(iframe);
                                                }, 1000);
                                            }
                                        };
                                    } else {
                                        // Not ready yet, retry in 3 seconds
                                        setTimeout(checkQR, 3000);
                                    }
                                })
                                .catch(() => {
                                    setTimeout(checkQR, 3000);
                                });
                        }

                        // Start checking immediately
                        checkQR();
                    </script>
                </body>
                </html>
            `);
        }
    });

    server.listen(PORT, "0.0.0.0", () => {
        console.log(`🌐 [SYSTEM] Web Server running at port ${PORT}`);
        console.log(`🔗 [SYSTEM] QR Page: /qr`);
    });
}

module.exports = { startWebServer };
