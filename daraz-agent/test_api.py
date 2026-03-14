#!/usr/bin/env python3
"""
test_openai.py - Quick test to verify your OpenAI API key works
Run: python test_api.py
"""

import os
import openai

API_KEY = os.getenv("OPENAI_API_KEY", "")

if not API_KEY:
    print("✗ FAILED - OPENAI_API_KEY environment variable not set.")
    exit(1)

print("Testing OpenAI API key...")
print(f"Key starts with: {API_KEY[:10]}...")

try:
    client = openai.OpenAI(api_key=API_KEY)
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": "Say hello in one sentence."}],
        max_tokens=50,
    )
    print("\n✓ SUCCESS! API key is working.")
    print(f"Response: {response.choices[0].message.content}")

except openai.AuthenticationError:
    print("\n✗ FAILED - Invalid API key. Check your key at platform.openai.com/api-keys")

except openai.RateLimitError:
    print("\n✗ FAILED - Rate limit or no credits. Add credits at platform.openai.com/billing")

except openai.APIConnectionError:
    print("\n✗ FAILED - No internet connection.")

except Exception as e:
    print(f"\n✗ FAILED - {e}")
