import subprocess
import tempfile
import os
import base64
import json
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Configure Gemini with the new SDK
api_key = os.getenv("GEMINI_API_KEY")
if api_key and api_key != "your_api_key_here":
    client = genai.Client(api_key=api_key)
    # Gemini 3 Flash with thinking support
    MODEL_ID = "gemini-3-flash-preview"
else:
    client = None

app = FastAPI(title="OpenScience Prism API")

# Allow CORS
origins = [
    "http://localhost:3000",
    "http://localhost:3001",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "OpenScience Prism API is running!"}

@app.get("/health")
def health_check():
    return {"status": "ok", "gemini_ready": client is not None}

class CompileRequest(BaseModel):
    latex_source: str

@app.post("/compile")
async def compile_latex(request: CompileRequest):
    latex_source = request.latex_source
    with tempfile.TemporaryDirectory() as temp_dir:
        tex_filename = "document.tex"
        with open(os.path.join(temp_dir, tex_filename), "w") as f:
            f.write(latex_source)
        try:
            cmd = ["pdflatex", "-interaction=nonstopmode", tex_filename]
            subprocess.run(cmd, cwd=temp_dir, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            pdf_path = os.path.join(temp_dir, "document.pdf")
            if os.path.exists(pdf_path):
                with open(pdf_path, "rb") as f:
                    return Response(content=f.read(), media_type="application/pdf")
            raise HTTPException(status_code=500, detail="PDF not generated.")
        except subprocess.CalledProcessError as e:
            raise HTTPException(status_code=400, detail=f"LaTeX Error: {e.stdout.decode(errors='replace')[-500:]}")

class ChatMessage(BaseModel):
    role: str
    content: str

class ChatRequest(BaseModel):
    message: str
    latex_context: str
    image: Optional[str] = None
    history: Optional[list[ChatMessage]] = None
    agent_mode: bool = False

@app.post("/chat")
async def chat_with_gemini(request: ChatRequest):
    if not client:
        async def no_api_key_stream():
            yield f"data: {json.dumps({'content': 'Gemini API key not configured. Please add GEMINI_API_KEY to your backend/.env file.'})}\n\n"
            yield f"data: {json.dumps({'done': True})}\n\n"
        return StreamingResponse(
            no_api_key_stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"}
        )
    
    # Build conversation history string
    history_str = ""
    if request.history and len(request.history) > 0:
        history_str = "\n\nCONVERSATION HISTORY:\n"
        for msg in request.history:
            role_label = "User" if msg.role == "user" else "Assistant"
            history_str += f"{role_label}: {msg.content}\n"
    
    # Build the prompt based on agent mode
    if request.agent_mode:
        text_prompt = f"""
    You are an AI coding agent in OpenScience Prism, a LaTeX editor for writing papers. You have the ability to directly modify the user's LaTeX code.

    AGENT MODE GUIDELINES:
    - When the user asks you to make changes to their document, you MUST provide the complete updated LaTeX code.
    - Wrap your code changes with special markers: <<<APPLY_CODE>>> at the start and <<<END_CODE>>> at the end.
    - Always provide the COMPLETE LaTeX document between these markers, not just the changed parts.
    - Before the code block, briefly explain what changes you're making.
    - After making changes, confirm what was modified.
    - If the user's request is unclear, ask for clarification before making changes.
    - Be proactive: if you see obvious improvements, suggest and apply them.

    EXAMPLE FORMAT:
    I'll add a new section about methodology to your document.

    <<<APPLY_CODE>>>
    \\documentclass{{article}}
    ... (complete LaTeX code here) ...
    \\end{{document}}
    <<<END_CODE>>>

    I've added a new "Methodology" section after the Introduction.

    CURRENT LATEX SOURCE:
    ```latex
    {request.latex_context}
    ```
    {history_str}
    USER MESSAGE:
    {request.message}
    """
    else:
        text_prompt = f"""
    You are a friendly and helpful scientific research assistant in OpenScience Prism, a LaTeX editor for writing papers.
    
    GUIDELINES:
    - Be conversational and natural. Match the tone and length of your response to the user's message.
    - For casual messages (greetings, small talk), respond briefly and warmly.
    - Only provide detailed LaTeX suggestions, research advice, or fact-checking when the user specifically asks for help.
    - Keep responses concise unless the user asks for elaboration.
    - If an image is provided, analyze it and describe what you see.
    
    CONTEXT (for reference when needed):
    Current LaTeX source:
    ```latex
    {request.latex_context}
    ```
    {history_str}
    USER MESSAGE:
    {request.message}
    """
    
    contents = [types.Part.from_text(text=text_prompt)]

    if request.image:
        try:
            if "base64," in request.image:
                _, encoded = request.image.split("base64,", 1)
                image_bytes = base64.b64decode(encoded)
                contents.append(types.Part.from_bytes(data=image_bytes, mime_type="image/png"))
        except Exception as e:
            print(f"Error processing image: {e}")

    async def generate_stream():
        try:
            # Use GenerateContentConfig to enable Thinking and Code Execution
            # For Gemini 3: use thinking_level (not thinking_budget)
            # include_thoughts=True returns thought summaries in the response
            config = types.GenerateContentConfig(
                thinking_config=types.ThinkingConfig(
                    thinking_level="high",
                    include_thoughts=True
                ),
                tools=[types.Tool(code_execution=types.ToolCodeExecution())]
            )

            # Use streaming API
            response_stream = client.models.generate_content_stream(
                model=MODEL_ID,
                contents=contents,
                config=config
            )
            
            for chunk in response_stream:
                if not chunk.candidates or not chunk.candidates[0].content or not chunk.candidates[0].content.parts:
                    continue
                    
                for part in chunk.candidates[0].content.parts:
                    # Check if this is a thought part (thought summary)
                    # For Gemini 3, part.thought is True for thought summaries
                    is_thought = getattr(part, "thought", False)
                    part_text = getattr(part, "text", None)
                    
                    if is_thought and part_text:
                        # This is a thought summary
                        yield f"data: {json.dumps({'thought': part_text})}\n\n"
                    elif part_text:
                        # Regular content
                        yield f"data: {json.dumps({'content': part_text})}\n\n"
            
            # Signal end of stream
            yield f"data: {json.dumps({'done': True})}\n\n"
            
        except Exception as e:
            print(f"Gemini 3 API Error: {str(e)}")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    return StreamingResponse(
        generate_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )