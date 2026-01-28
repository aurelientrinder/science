# Carbon

An AI-enhanced research and paper writing workspace.

## Project Structure

- **frontend/**: Next.js (React) application. The workspace interface.
- **backend/**: Python (FastAPI) application. The logic, AI agents, and LaTeX engine.

## Getting Started

### 1. Backend (Python/FastAPI)

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.
Docs: `http://localhost:8000/docs`

### 2. Frontend (Next.js)

```bash
cd frontend
npm install
npm run dev
```

The app will be available at `http://localhost:3000`.
