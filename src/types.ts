
// NewsData.io API
export interface NewsArticle {
    article_id: string;
    title: string;
    link: string;
    description: string | null;
    content: string | null;
    pubDate: string;
    image_url: string | null;
    source_id: string;
    source_priority: number;
    country: string[];
    category: string[];
    language: string;
}

export interface NewsDataResponse {
    status: string;
    totalResults: number;
    results: NewsArticle[];
    nextPage: string | null;
}

// Gemini Analysis Result
export interface GeminiAnalysisResult {
    chosenId: number;
    headline: string;
    highlightWords: string[];
    imagePrompt: string;
    caption: string;
    sourceName: string;
}

// Category definition
export interface NewsCategory {
    name: string;
    apiValue: string;
}

// Headline part for rendering highlights
export interface HeadlinePart {
    text: string;
    highlighted: boolean;
}
