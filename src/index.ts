
import * as React from 'react';
import { GoogleGenAI } from '@google/genai';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { NewsArticle, NewsCategory, GeminiAnalysisResult, HeadlinePart, NewsDataResponse } from './types';

// --- START: Hardcoded Configuration ---
// Secrets / API Keys
const GEMINI_API_KEY = 'AIzaSyAp0A5k9v_03To0RNieHAhAPGEc_1gEuz4';
const NEWSDATA_API_KEY = 'pub_1058e1309a4d4112a59c6f7847c1a98a';
const CLOUDINARY_CLOUD_NAME = 'dukaroz3u';
const CLOUDINARY_API_KEY = '151158368369834';
const CLOUDINARY_UPLOAD_PRESET = 'Autoupload';
const MAKE_WEBHOOK_URL = 'https://hook.eu2.make.com/mvsz33n18i6dl18xynls7ie9gnoxzghl';
const MAKE_WEBHOOK_AUTH_TOKEN = 'xR@7!pZ2#qLd$Vm8^tYe&WgC*oUeXsKv';
const LOG_WEBHOOK_URL = 'https://hook.eu2.make.com/0ui64t2di3wvvg00fih0d32qp9i9jgme';

// Constants
const LOGO_URL = 'https://res.cloudinary.com/dy80ftu9k/image/upload/v1753507647/scs_cqidjz.png';
const BRAND_TEXT = 'Dhaka Dispatch';
const OVERLAY_IMAGE_URL = 'https://res.cloudinary.com/dy80ftu9k/image/upload/v1753644798/Untitled-1_hxkjvt.png';
// --- END: Hardcoded Configuration ---

// Dummy definitions for Cloudflare Worker types
interface ScheduledController {}
interface ExecutionContext {
    waitUntil(promise: Promise<any>): void;
}

type LogLevel = 'INFO' | 'ERROR' | 'SUCCESS' | 'WARNING';

/**
 * Sends a log message to the console and to a specified webhook URL.
 * The webhook call is "fire-and-forget" and does not block execution.
 */
function log(level: LogLevel, message: string, data: object = {}) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${level}] ${message}`;

    if (level === 'ERROR') {
        console.error(timestamp, logMessage, data);
    } else {
        console.log(timestamp, logMessage, data);
    }

    if (!LOG_WEBHOOK_URL) return;

    const payload = {
        timestamp,
        level,
        message,
        ...data,
    };

    // Non-blocking call to the webhook
    const promise = fetch(LOG_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).catch(e => console.error("Log webhook fetch failed:", e));
}


const NEWS_CATEGORIES: NewsCategory[] = [
    { "name": "Trending", "apiValue": "top" },
    { "name": "Politics", "apiValue": "politics" },
    { "name": "Crime", "apiValue": "crime" },
    { "name": "Entertainment", "apiValue": "entertainment" },
    { "name": "Business/Corporate", "apiValue": "business" }
];

export default {
    async scheduled(_controller: ScheduledController, _env: any, ctx: ExecutionContext): Promise<void> {
        log('INFO', "Cron trigger received. Starting batch process...");
        ctx.waitUntil(processNewsBatch());
    },
    async fetch(_request: Request, _env: any, ctx: ExecutionContext): Promise<Response> {
        log('INFO', "Manual trigger received. Starting batch process...");
        ctx.waitUntil(processNewsBatch());
        return new Response("News processing batch triggered successfully.", { status: 202 });
    }
};

async function processNewsBatch(): Promise<void> {
    log('INFO', "--- Starting New Batch Process ---");
    const usedArticleUrls = new Set<string>();
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    for (const category of NEWS_CATEGORIES) {
        log('INFO', `Processing category: ${category.name}`, { category: category.name });
        try {
            // Step 3: Fetch News
            let articles = await fetchNewsForCategory(category, usedArticleUrls);
            if (articles.length === 0) {
                log('WARNING', `No new, valid articles found for ${category.name}. Skipping.`, { category: category.name });
                continue;
            }

            // Step 4: Analyze & Select Best Article
            const analysisResult = await analyzeArticlesWithGemini(articles, ai);
            if (!analysisResult) {
                log('WARNING', `Gemini found no relevant articles in ${category.name}. Skipping.`, { category: category.name });
                continue;
            }
            const chosenArticle = articles[analysisResult.chosenId - 1];
            usedArticleUrls.add(chosenArticle.link);
            log('INFO', `Chosen article: "${chosenArticle.title}"`, { link: chosenArticle.link });

            // Step 5: Prepare Main Image Source
            const mainImageSrc = await prepareMainImage(chosenArticle, analysisResult.imagePrompt, ai);
            if (!mainImageSrc) {
                 log('ERROR', `Failed to fetch or generate main image for article: ${chosenArticle.link}`, { article: chosenArticle });
                 continue;
            }

            // Step 6: Compose Final Image
            log('INFO', "Composing final image...", { category: category.name });
            const finalImageBase64 = await composeFinalImage(analysisResult, mainImageSrc);

            // Step 7: Upload to Cloudinary
            log('INFO', "Uploading image to Cloudinary...", { category: category.name });
            const cloudinaryUrl = await uploadToCloudinary(finalImageBase64);

            // Step 8: Send to Webhook
            log('INFO', "Sending data to Make.com webhook...", { category: category.name });
            await sendToWebhook(analysisResult, cloudinaryUrl, chosenArticle);

            log('SUCCESS', `Successfully processed and posted for category: ${category.name}`, { category: category.name, imageUrl: cloudinaryUrl });

        } catch (error) {
            const errorDetails = error instanceof Error ? { message: error.message, stack: error.stack } : { error: String(error) };
            log('ERROR', `!!! FAILED to process category ${category.name} !!!`, { category: category.name, ...errorDetails });
            // Continue to the next category
        }
    }
    log('INFO', "--- Batch Process Finished ---");
}

async function fetchNewsForCategory(category: NewsCategory, usedUrls: Set<string>): Promise<NewsArticle[]> {
    let rawArticles: NewsArticle[] = [];
    
    if (category.apiValue === "top") {
        log('INFO', "Fetching for special 'Trending' category...");
        const otherCategories = NEWS_CATEGORIES.filter(c => c.apiValue !== "top").map(c => c.apiValue);
        const promises = otherCategories.map(cat => {
            const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&country=bd&language=en&image=1&size=10&category=${cat}`;
            return fetch(url).then(res => res.json() as Promise<NewsDataResponse>);
        });
        const responses = await Promise.all(promises);
        const allArticles = responses.flatMap(r => r.results || []);
        
        const uniqueArticles = Array.from(new Map(allArticles.map(a => [a.link, a])).values());
        uniqueArticles.sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
        rawArticles = uniqueArticles.slice(0, 10);

    } else {
        log('INFO', `Fetching news for '${category.apiValue}'...`);
        const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_API_KEY}&country=bd&language=en&image=1&size=10&category=${category.apiValue}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`NewsData API request failed: ${response.statusText}`);
        const data: NewsDataResponse = await response.json();
        rawArticles = data.results || [];
    }

    const validArticles = rawArticles.filter(a => a.image_url && (a.content || a.description));
    const unusedArticles = validArticles.filter(a => !usedUrls.has(a.link));

    log('INFO', `Found ${unusedArticles.length} new, valid articles for ${category.name}.`);
    return unusedArticles;
}

function buildGeminiPrompt(articles: NewsArticle[]): string {
    const articlesString = articles.map((article, index) =>
        `ARTICLE ${index + 1}:\nID: ${index + 1}\nTitle: ${article.title}\nContent: ${article.content || article.description}\nSource: ${article.source_id}\n---`
    ).join('\n');

    return `
You are an expert news editor for a Bangladeshi social media channel. Your goal is to find the single most important, impactful, and relevant story for your audience from a list of recent articles.

**Your First Task: Select the Best Article**
- You will be given a list of news articles.
- Review all articles and select the ONE that is most newsworthy and DIRECTLY about Bangladesh.
- **CRITICAL RULE:** The article's main subject MUST be Bangladesh. News about other countries (e.g., India) is NOT relevant unless Bangladesh or a Bangladeshi entity is a primary subject of the article (e.g., a bilateral agreement). An article about Indian politics is irrelevant. Be extremely strict.
- If NONE of the articles meet this strict criteria, you MUST respond with ONLY the single word: IRRELEVANT.

**If you find a suitable article, proceed to Your Second Task:**
- Identify the article you chose by its ID.
- Perform a full analysis on ONLY that chosen article.

**Analysis Steps:**
**1. Headline Generation (IMPACT Principle):** Informative, Main Point, Prompting Curiosity, Active Voice, Concise, Targeted.
**2. Highlight Phrase Identification:** Identify key phrases from your new headline that capture critical information (entities, key terms, numbers). List these exact phrases, separated by commas.
**3. Image Prompt Generation (SCAT Principle & Safety):** Generate a concise, descriptive prompt for an AI image generator. The prompt MUST be safe for work and MUST NOT contain depictions of specific people (especially political figures), violence, conflict, or other sensitive topics. Instead, focus on symbolic, abstract, or neutral representations of the news. For example, for a political story, prompt "Gavel on a table with a Bangladeshi flag in the background" instead of showing politicians. The prompt should follow the SCAT principle (Subject, Context, Atmosphere, Type).
**4. Caption & Source:** Create a social media caption (~50 words) with 3-5 relevant hashtags.

**List of Articles to Analyze:**
${articlesString}

**Output Format (Strict):**
- If no article is relevant, respond ONLY with: IRRELEVANT
- If you find a relevant article, respond ONLY with the following format. Do not add any other text or formatting. Each field must be on a new line.

CHOSEN_ID: [The ID number of the article you selected]
HEADLINE: [Your generated headline for the chosen article]
HIGHLIGHT_WORDS: [phrase 1, phrase 2]
IMAGE_PROMPT: [Your generated image prompt]
CAPTION: [Your generated caption. Crucially, DO NOT include the source name in the caption.]
SOURCE_NAME: [The source name (e.g., 'thedailystar') from the chosen article. This is a mandatory and separate field.]
    `;
}

async function analyzeArticlesWithGemini(articles: NewsArticle[], ai: GoogleGenAI): Promise<GeminiAnalysisResult | null> {
    log('INFO', "Analyzing articles with Gemini...");
    const prompt = buildGeminiPrompt(articles);
    const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
    });

    const text = result.text.trim();
    if (text === "IRRELEVANT") {
        return null;
    }

    try {
        const lines = text.split('\n').map(line => line.trim());
        const data: { [key: string]: string } = {};
        lines.forEach(line => {
            const [key, ...valueParts] = line.split(':');
            if (key && valueParts.length > 0) {
                data[key.trim()] = valueParts.join(':').trim();
            }
        });

        return {
            chosenId: parseInt(data['CHOSEN_ID'], 10),
            headline: data['HEADLINE'],
            highlightWords: data['HIGHLIGHT_WORDS'].split(',').map(w => w.trim()),
            imagePrompt: data['IMAGE_PROMPT'],
            caption: data['CAPTION'],
            sourceName: data['SOURCE_NAME']
        };
    } catch (e) {
        throw new Error(`Failed to parse Gemini response: ${text}`);
    }
}

async function prepareMainImage(article: NewsArticle, geminiPrompt: string, ai: GoogleGenAI): Promise<string | null> {
    log('INFO', "Preparing main image. Trying to fetch original article image first...");
    if (article.image_url) {
        try {
            const response = await fetch(article.image_url);
            if (response.ok) {
                log('INFO', "Original image fetched successfully. Converting to base64...");
                const blob = await response.blob();
                const buffer = await blob.arrayBuffer();
                let binary = '';
                const bytes = new Uint8Array(buffer);
                for (let i = 0; i < bytes.byteLength; i++) {
                    binary += String.fromCharCode(bytes[i]);
                }
                const base64Image = btoa(binary);
                const mimeType = response.headers.get("Content-Type") || "image/png";
                return `data:${mimeType};base64,${base64Image}`;
            }
            log('WARNING', `Failed to fetch original image: ${response.status}. Generating new one.`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : "Unknown error";
            log('WARNING', `Error fetching original image: ${errorMessage}. Generating new one.`);
        }
    }

    log('INFO', "Generating image with Gemini Imagen...");
    const imageResponse = await ai.models.generateImages({
        model: 'imagen-3.0-generate-002',
        prompt: geminiPrompt,
        config: {
            numberOfImages: 1,
            outputMimeType: 'image/png',
            aspectRatio: '4:3',
        },
    });

    if (imageResponse.generatedImages && imageResponse.generatedImages.length > 0) {
        const base64ImageBytes = imageResponse.generatedImages[0].image.imageBytes;
        return `data:image/png;base64,${base64ImageBytes}`;
    }

    return null;
}


// Fetches fonts for Satori. Caching is handled by Cloudflare's default fetch behavior.
const getFontData = async (url: string): Promise<ArrayBuffer> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch font: ${url}`);
    return response.arrayBuffer();
};

const splitHeadlineForHighlighting = (headline: string, highlightWords: string[]): HeadlinePart[] => {
    if (!highlightWords || highlightWords.length === 0 || highlightWords[0] === '') {
        return [{ text: headline, highlighted: false }];
    }
    const regex = new RegExp(`(${highlightWords.join('|')})`, 'gi');
    const parts = headline.split(regex);
    return parts.filter(part => part).map(part => ({
        text: part,
        highlighted: highlightWords.some(h => h.toLowerCase() === part.toLowerCase())
    }));
};

const getDynamicFontSize = (headline: string): number => {
    const length = headline.length;
    if (length <= 50) return 72;
    if (length <= 80) return 64;
    if (length <= 120) return 56;
    if (length <= 160) return 48;
    return 40; // Smallest size for very long headlines
};

async function composeFinalImage(analysis: GeminiAnalysisResult, mainImageSrc: string): Promise<string> {
    const poppinsRegular = await getFontData('https://fonts.gstatic.com/s/poppins/v21/pxiEyp8kv8JHgFVrJJbecnFHGPezSQ.woff2');
    const poppinsBold = await getFontData('https://fonts.gstatic.com/s/poppins/v21/pxiByp8kv8JHgFVrLBT5Z1xlFQ.woff2');
    const interSemiBold = await getFontData('https://fonts.gstatic.com/s/inter/v13/UcC73FwrK3iLTeHuS_fvQtMwCp50KnMa1ZL7.woff2');

    const headlineParts = splitHeadlineForHighlighting(analysis.headline, analysis.highlightWords);
    const fontSize = getDynamicFontSize(analysis.headline);

    const satoriElement = React.createElement('div', {
            style: {
                display: 'flex',
                flexDirection: 'column',
                width: 1080,
                height: 1080,
                backgroundColor: 'white',
                fontFamily: '"Poppins"',
                position: 'relative'
            }
        },
        // Top Area for Headline
        React.createElement('div', {
                style: {
                    height: 324,
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '20px 40px',
                    backgroundColor: 'white'
                }
            },
            React.createElement('p', {
                    style: {
                        fontSize: fontSize,
                        fontWeight: 700,
                        color: '#111827',
                        textAlign: 'center',
                        lineHeight: 1.2,
                        margin: 0,
                        display: 'flex',
                        flexWrap: 'wrap',
                        justifyContent: 'center'
                    }
                },
                ...headlineParts.map((part, i) => (
                    React.createElement('span', {
                        key: i,
                        style: {
                            backgroundColor: part.highlighted ? '#ef4444' : 'transparent',
                            color: part.highlighted ? 'white' : '#111827',
                            padding: '0 8px',
                            margin: '0 2px'
                        }
                    }, part.text)
                ))
            )
        ),
        // Separator Line
        React.createElement('div', { style: { height: 5, width: '100%', backgroundColor: 'black' } }),
        // Main Image Area
        React.createElement('div', {
            style: {
                height: 756,
                width: '100%',
                display: 'flex',
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                backgroundSize: 'cover',
                backgroundImage: `url(${mainImageSrc})`
            }
        }),
        // Overlays
        React.createElement('img', {
            src: OVERLAY_IMAGE_URL,
            style: { position: 'absolute', top: 0, left: 0, width: 1080, height: 1080 }
        }),
        React.createElement('img', {
            src: LOGO_URL,
            style: { position: 'absolute', bottom: 20, left: 20, width: 200, height: 60, objectFit: 'contain' }
        }),
        React.createElement('div', {
                style: {
                    position: 'absolute',
                    bottom: 25,
                    right: 30,
                    color: 'white',
                    fontFamily: '"Inter"',
                    fontSize: 24,
                    fontWeight: 600,
                    textShadow: '1px 1px 3px black'
                }
            },
            BRAND_TEXT
        )
    );

    const svg = await satori(
        satoriElement,
        {
            width: 1080,
            height: 1080,
            fonts: [
                { name: 'Poppins', data: poppinsRegular, weight: 400, style: 'normal' },
                { name: 'Poppins', data: poppinsBold, weight: 700, style: 'normal' },
                { name: 'Inter', data: interSemiBold, weight: 600, style: 'normal' },
            ],
        }
    );

    const resvg = new Resvg(svg, {
        fitTo: { mode: 'width', value: 1080 },
    });
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    // Convert ArrayBuffer to Base64
    let binary = '';
    const bytes = new Uint8Array(pngBuffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return `data:image/png;base64,${btoa(binary)}`;
}


async function uploadToCloudinary(imageBase64: string): Promise<string> {
    const formData = new FormData();
    formData.append('file', imageBase64);
    formData.append('api_key', CLOUDINARY_API_KEY);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    const response = await fetch(
        `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
        {
            method: 'POST',
            body: formData,
        }
    );

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cloudinary upload failed: ${response.status} ${errorText}`);
    }

    const data: { secure_url: string } = await response.json();
    return data.secure_url;
}

async function sendToWebhook(analysis: GeminiAnalysisResult, imageUrl: string, article: NewsArticle): Promise<void> {
    const payload = {
        headline: analysis.headline,
        imageUrl: imageUrl,
        summary: analysis.caption,
        newsLink: article.link,
        status: "Queue"
    };

    const response = await fetch(MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-make-apikey': MAKE_WEBHOOK_AUTH_TOKEN
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Webhook failed: ${response.status} ${errorText}`);
    }
    log('SUCCESS', "Webhook call successful.");
}
