"""
FastAPI server — POST /search accepts multipart form:
  - image: file upload
  - product_name: string

Returns JSON with ranked video results.
"""
import os, tempfile, shutil
from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from searcher import find_product_videos

app = FastAPI(title="Product Video Search API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/search")
async def search(
    image: UploadFile = File(...),
    product_name: str = Form(...),
):
    if not product_name.strip():
        raise HTTPException(400, "product_name is required")

    # save upload to a temp file
    suffix = "." + image.filename.rsplit(".", 1)[-1] if "." in image.filename else ".jpg"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        shutil.copyfileobj(image.file, tmp)
        tmp_path = tmp.name

    try:
        result = find_product_videos(tmp_path, product_name)
        return JSONResponse(result)
    except Exception as e:
        raise HTTPException(500, str(e))
    finally:
        os.unlink(tmp_path)

@app.get("/health")
def health():
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn, os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("server:app", host="0.0.0.0", port=port)
