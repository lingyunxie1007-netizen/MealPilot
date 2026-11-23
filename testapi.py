import os
from openai import OpenAI

BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
API_KEY = os.environ["OPENAI_API_KEY"]
MODEL_ID = "deepseek-v4-flash-ga-260731"

client = OpenAI(
    base_url=BASE_URL,
    api_key=API_KEY
)

stream = client.chat.completions.create(
    model=MODEL_ID,
    messages=[{"role":"user","content":"一句话介绍你"}],
    stream=True
)

print("✅ 流式输出：")
for chunk in stream:
    if chunk.choices and chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
