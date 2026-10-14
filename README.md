## Installation and Setup

### Prerequisites

Before running WhatsApp Listener, install:

- **Node.js** — Recommended: Node.js 24 LTS, including npm. Download: https://nodejs.org/
- **Git** — Required to clone the repository. Download: https://git-scm.com/
- **WhatsApp** — An active WhatsApp account on a phone, with access to the **Linked Devices** feature.

No Python installation, Android emulator, or WhatsApp Business API is required.

### 1. Clone the repository

```bash
git clone https://github.com/AdamNassir/WhatsAppListener.git
cd WhatsAppListener
```

### 2. Install dependencies

```bash
npm install
```

This installs the libraries declared in `package.json`, including:

- `@whiskeysockets/baileys` — WhatsApp linked-device communication
- `express` — Local web server
- `qrcode` — QR code generation
- `pino` — Logging
- `@hapi/boom` — Error handling
- `tsx` — TypeScript execution

### 3. Start the application

```bash
npm run start
```

When the server starts, the terminal displays:

```text
Control panel: http://localhost:3000
```

Open **http://localhost:3000** in your browser.

### 4. Connect a WhatsApp account

1. Create a user in the control panel.
2. Click **Connect / show QR**.
3. On the corresponding phone, open WhatsApp → **Linked Devices** → **Link a device**.
4. Scan the QR code displayed in the control panel.
5. Wait until the account status changes to **connected**.

Each configured user has a separate WhatsApp authentication session.

### 5. Configure and run listeners

1. Select the user.
2. Enable **Process this user when Run listeners is pressed**.
3. Select the conversations to archive, or enable **Listen to every conversation**.
4. Choose which media types to download.
5. Set the download directory.
6. Click **Save settings**, then **Run listeners**.

Multiple enabled accounts can operate simultaneously.

### Supported content

The application can archive new WhatsApp messages and supported media:

- Text messages (sent and received), saved as JSON
- Images
- PDF and other documents
- Videos
- Audio files and voice notes
- Stickers

**Media downloads depend on the enabled media rules. Existing conversation history is not automatically archived.**

### Security and privacy

- Only use the application with accounts you own or are explicitly authorized to manage.
- Authentication credentials are stored locally in `data/auth/`.
- Archived text messages are stored in `data/texts/`.
- Media is stored under the configured download directories.
- Conversation filters restrict which messages and files the application archives. They do not prevent the WhatsApp connection from receiving other message events.
- **Never commit authentication credentials, archived messages, or private media to GitHub.**
- The current control panel has no login protection. Run it in a trusted local environment and do not expose port 3000 publicly.

### Troubleshooting

**`npm` is not recognized:** Install Node.js and restart your terminal.

**Dependencies are missing:** Run `npm install` again.

**Port 3000 is already in use:** Stop any existing application instance using that port.

**My messages are not extracted:** Make sure to check the "Include messages sent by this account" option.