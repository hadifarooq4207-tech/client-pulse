# ClientPulse — Mini Dashboard (MVP)

ClientPulse is a lightweight client reminder & follow-up dashboard (mini SaaS MVP).  
This version is designed to be quick to deploy (GitHub + Vercel) and simple to use.

---

## Features
- Add clients (name, email, phone, notes)
- Schedule reminders for a client (date/time, message, repeat)
- Run a reminder immediately ("Run Now")
- Activity log with timestamped entries
- In-memory storage (fast MVP). Export data as JSON.
- Optional real email sending via SMTP (nodemailer) if env variables provided

---

## Quick start (local)
1. Install Node.js v18+  
2. Clone the repo, then:
```bash
npm install
