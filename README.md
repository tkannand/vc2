# Connect PWA

Voter outreach management system with role-based access control.

## Roles
- **Super Admin**: Dashboard, user management, activity logs. No phone number access.
- **Ward Supervisor**: Ward-level stats, booth drill-down with voter calling capability.
- **Booth Worker**: Street-based voter calling workflow with family grouping.

## Setup

1. Copy `.env.example` to `.env` and fill in values
2. Install dependencies: `pip install -r requirements.txt`
3. Run: `uvicorn backend.main:app --reload --port 8000`
4. Open: `http://localhost:8000`

## Initial Super Admin
Phone: 8903429890 (configurable in .env)

## Deployment
Build Docker image: `docker build -t voterconnect .`
Run: `docker run -p 8000:8000 --env-file .env voterconnect`
