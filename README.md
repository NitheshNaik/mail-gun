# Bulk Personalized Email Sender

A production-ready full-stack application built with **React** (Vite + Custom CSS) and **Node.js (Express + Nodemailer)**. It enables administrators to upload a CSV file of contacts, compose a message template, and dispatch personalized, dynamic emails (e.g. prepending "Hi [Name]").

---

## Features

- **Responsive Glassmorphism UI:** Built using Vanilla CSS with high-end dark aesthetics, loading animations, hover transitions, and a clean side-by-side composer/tracker layout.
- **Drag-and-Drop CSV Uploader:** Easily drag and drop `.csv` files containing names and emails. Supports automatic column header detection.
- **Dynamic Personalization:** Automatically prepends `"Hi [Name] "` (with name properly capitalized) to the template for each recipient.
- **Real-time Delivery Tracker:** Displays statistical counters (Total, Pending, Sent, Failed), active progress bar, and status lists with filtering.
- **Robust Backend Logging:** Prints personalized message copies and sending status directly to the console.

---

## Directory Structure

```text
email/
├── backend/
│   ├── uploads/            # Temporary directory for CSV uploads
│   ├── .env                # Local SMTP configurations (git-ignored)
│   ├── .env.example        # Environment variable template
│   ├── package.json        # Backend dependencies
│   └── server.js           # Express server and Nodemailer logic
├── frontend/
│   ├── index.html          # App entrypoint
│   ├── package.json        # Frontend React/Vite dependencies
│   └── src/
│       ├── App.jsx         # Main composer & UI component
│       ├── App.css         # Custom layout/component styling
│       ├── index.css       # Design tokens and theme settings
│       └── main.jsx        # React DOM render entry
├── test.csv                # Sample CSV file for testing
└── README.md               # Setup and running instructions
```

---

## How to Run

Follow these steps to run the application locally:

### Step 1: Configure SMTP Environment Variables
1. Navigate to the `backend/` directory:
   ```bash
   cd backend
   ```
2. Copy the `.env.example` file to `.env`:
   ```bash
   cp .env.example .env
   ```
3. Open `.env` and fill in your SMTP credentials:
   ```env
   PORT=5000
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=587
   SMTP_SECURE=false
   SMTP_USER=your-email@gmail.com
   SMTP_PASS=your-app-password
   SMTP_FROM_NAME="Exposys Data Lab"
   ```

> [!TIP]
> **Using Gmail SMTP:**
> 1. Go to your Google Account Settings.
> 2. Enable **2-Step Verification**.
> 3. Search for **App Passwords** in the search bar.
> 4. Create an app password (e.g., named "Bulk Emailer").
> 5. Copy the 16-character password generated and paste it as `SMTP_PASS` in your `.env` file. Do not use your regular account password.

---

### Step 2: Install Dependencies & Run the Backend
From the root directory:
```bash
cd backend
npm install
npm run dev
```
The backend server will run on `http://localhost:5000`.

---

### Step 3: Install Dependencies & Run the Frontend
Open a new terminal tab/window and run from the root directory:
```bash
cd frontend
npm install
npm run dev
```
The frontend dev server will launch at `http://localhost:5173`. Open this URL in your browser to interact with the application.

---

## Verification with test.csv
You can upload the provided `test.csv` in the root folder to test parsing. It contains standard columns:
```csv
Name,Email
rahul,rahul@gmail.com
aditya,aditya@gmail.com
neha sharma,neha.sharma@example.com
```

The app will parse and display:
- **Rahul** (`rahul@gmail.com`)
- **Aditya** (`aditya@gmail.com`)
- **Neha Sharma** (`neha.sharma@example.com`)

The live preview will show the personalized template body:
`Hi Rahul welcome to exposys data lab coding round`




Start Redis — ``` docker run -d -p 6379:6379 redis:7-alpine ```
Start the API server — ```cd backend && npm run dev```
Start the Worker — ```cd backend && npm run worker ``` (you'll see the provider stats table on startup)
Start the frontend — ```cd frontend && npm run dev```

For tomorrow's presentation — just run ```node reset-smtp.mjs``` once before you demo and all providers will show fresh quotas.