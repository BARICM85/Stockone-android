import requests
import os
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

FIRECRAWL_BASE_URL = os.getenv("FIRECRAWL_API_BASE_URL", "http://localhost:3002")
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "tinyllama")

def get_nse_data(symbol):
    """
    Scrape Tickertape for NSE stock data using Firecrawl.
    """
    print(f"--- Fetching live data for {symbol} via Firecrawl ---")
    url = f"https://www.tickertape.in/stocks/{symbol}"
    
    payload = {
        "url": url,
        "formats": ["markdown"]
    }
    
    try:
        response = requests.post(f"{FIRECRAWL_BASE_URL}/v1/scrape", json=payload)
        response.raise_for_status()
        data = response.json()
        return data.get('data', {}).get('markdown', '')
    except Exception as e:
        print(f"Error scraping {symbol}: {e}")
        return None

def analyze_strategy(content, symbol):
    """
    Analyze the scraped markdown content using local Ollama.
    Focuses on IV Percentiles and Trends for Indian Stocks.
    """
    print(f"--- Analyzing {symbol} with local Ollama ({OLLAMA_MODEL}) ---")
    
    prompt = f"""
    You are a Senior Quantitative Analyst. Analyze the following markdown content for the NSE stock {symbol}.
    
    Tasks:
    1. Identify current price and 1-year return.
    2. Estimate or extract Implied Volatility (IV) percentile if mentioned.
    3. Determine the short-term trend (Bullish/Bearish/Neutral).
    4. Provide a brief strategy suggestion (e.g., 'Wait for IV contraction' or 'Bullish trend continuing').

    Data:
    {content[:3000]}
    """
    
    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False
    }
    
    try:
        response = requests.post(f"{OLLAMA_BASE_URL}/api/generate", json=payload)
        response.raise_for_status()
        return response.json().get('response', '')
    except Exception as e:
        print(f"Error analyzing with Ollama: {e}")
        return None

if __name__ == "__main__":
    # Example for Reliance Industries
    stock_symbol = "reliance-industries-RELI"
    content = get_nse_data(stock_symbol)
    
    if content:
        analysis = analyze_strategy(content, stock_symbol)
        print("\n=== AI STRATEGY REPORT ===")
        print(analysis)
    else:
        print("Failed to retrieve data.")
