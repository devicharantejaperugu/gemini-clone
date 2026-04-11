import requests
from bs4 import BeautifulSoup
import sys
import os
import argparse
import json
import warnings

# Hard-force UTF-8 for Windows console output
if sys.platform == 'win32':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')

def crawl_url(url):
    try:
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        response = requests.get(url, headers=headers, timeout=15)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        # 1. Aggressive Junk Removal
        # Strip script, style, nav, footer, header, form, sidebar, and other non-content tags
        junk_tags = ["script", "style", "nav", "footer", "header", "form", "aside", "noscript", "iframe"]
        for tag in soup(junk_tags):
            tag.decompose()
            
        # 2. Content Targeting (Look for Article, Main, or Content divs)
        main_content = soup.find(['article', 'main']) or soup.find('div', class_=lambda x: x and ('content' in x.lower() or 'article' in x.lower() or 'post' in x.lower()))
        
        target = main_content if main_content else soup
        
        # 3. Clean and Extract Text
        text = target.get_text(separator='\n')
        
        # Break into lines and remove junk whitespace
        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        text = '\n'.join(chunk for chunk in chunks if chunk and len(chunk) > 5) # Ignore tiny fragments

        sys.stdout.write(text)
        sys.stdout.flush()
    except Exception as e:
        print(f"Crawler Exception: {str(e)}", file=sys.stderr)
        sys.exit(1)

from duckduckgo_search import DDGS
from googlesearch import search as gsearch

# Suppress warnings
warnings.filterwarnings("ignore", category=RuntimeWarning)

def search_web(query):
    """
    Hybrid Search: Tries multiple engines to ensure reliability.
    """
    final_results = []
    
    # Attempt 1: DuckDuckGo
    try:
        with DDGS() as ddgs:
            ddg_results = list(ddgs.text(query, max_results=5))
            for r in ddg_results:
                final_results.append({
                    "title": r.get('title'),
                    "url": r.get('href'),
                    "snippet": r.get('body'),
                    "source": "DuckDuckGo"
                })
    except Exception as e:
        print(f"DEBUG: DDG Search failed: {str(e)}", file=sys.stderr)

    # Attempt 2: Google Fallback (if DDG returned nothing or failed)
    if not final_results:
        try:
            # googlesearch-python returns a list of URLs
            g_urls = list(gsearch(query, num_results=5))
            for url in g_urls:
                # Basic results as we only have the URL from this simple library
                # The crawler will pull actual content later if needed
                final_results.append({
                    "title": "Web Result",
                    "url": url,
                    "snippet": "Direct source link found via Google.",
                    "source": "Google"
                })
        except Exception as e:
            print(f"DEBUG: Google Search failed: {str(e)}", file=sys.stderr)

    # Attempt 3: Query Broadening (if both failed)
    if not final_results and "today" in query.lower():
        broad_query = query.lower().replace("today", "2026").replace("today's", "2026")
        return search_web(broad_query) 

    sys.stdout.write(json.dumps(final_results))
    sys.stdout.flush()

if __name__ == "__main__":
    os.environ["LITELLM_LOG"] = "ERROR"
    
    parser = argparse.ArgumentParser(description="Web Crawler and Searcher")
    parser.add_argument("--url", type=str, help="URL to crawl")
    parser.add_argument("--search", type=str, help="Query to search")
    
    args = parser.parse_args()
    
    if args.url:
        crawl_url(args.url)
    elif args.search:
        search_web(args.search)
    else:
        print("Usage: python crawler.py --url <URL> OR python crawler.py --search <Query>", file=sys.stderr)
        sys.exit(1)
