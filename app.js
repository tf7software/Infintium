const express = require('express');
const fs = require('fs');
const path = require('path');
const markdown = require('markdown-it')();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
require('dotenv').config();

const app = express();
const PORT = 80;

// Initialize Google Generative AI
const genAI = new GoogleGenerativeAI(process.env.API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Parse URL-encoded bodies (form submissions)
app.use(express.urlencoded({ extended: true }));

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/index.html'));
});

// Serve homepage
app.get('/snake', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/snake.html'));
});

// In-memory cache for search results
const searchCache = new Map();

// Function to delete all files in the "articles" directory
const deleteArticlesFolder = () => {
  const articlesDir = path.join(__dirname, 'public/articles');
  fs.readdir(articlesDir, (err, files) => {
    if (err) {
      console.error(`Error reading the articles directory: ${err}`);
      return;
    }
    files.forEach((file) => {
      const filePath = path.join(articlesDir, file);
      fs.unlink(filePath, (err) => {
        if (err) {
          console.error(`Error deleting file ${file}: ${err}`);
        } else {
          console.log(`Deleted file: ${file}`);
        }
      });
    });
  });
};

// Schedule the deleteArticlesFolder function to run every 24 hours
setInterval(deleteArticlesFolder, 24 * 60 * 60 * 1000); // 24 hours in milliseconds

// Function to sanitize scraped data
const sanitizeScrapedData = (text) => {
  return text.replace(/[\n\r]/g, ' ').trim(); // Remove newlines, trim whitespace
};

// Function to scrape search results from SerpAPI
const scrapeSerpApiSearch = async (query) => {
  if (searchCache.has(query)) {
    console.log("Serving from cache");
    return searchCache.get(query);
  }

  const apiKey = process.env.SERPAPI_API_KEY;
  const formattedQuery = encodeURIComponent(query);
  const url = `https://serpapi.com/search.json?q=${formattedQuery}&api_key=${apiKey}`;

  try {
    const { data } = await axios.get(url);

    if (!data.organic_results || !Array.isArray(data.organic_results)) {
      console.error("No organic results found in the response.");
      return [];
    }

    const links = data.organic_results.map(result => result.link).filter(link => link && link.startsWith('http'));
    console.log("Collected URLs:", links);

    // Cache the result for 24 hours
    searchCache.set(query, links);
    setTimeout(() => searchCache.delete(query), 24 * 60 * 60 * 1000);

    return links;
  } catch (error) {
    console.error("Error scraping SerpAPI:", error);
    return [];
  }
};

// Function to scrape images from SerpAPI
const scrapeSerpApiImages = async (query) => {
  if (searchCache.has(query)) {
    console.log("Serving images from cache");
    return searchCache.get(query);
  }

  const apiKey = process.env.SERPAPI_API_KEY;
  const url = `https://serpapi.com/search.json?engine=google_images&q=${query}&api_key=${apiKey}`;

  try {
    const { data } = await axios.get(url);
    const images = data.images_results.slice(0, 10).map(img => ({
      thumbnail: img.thumbnail,
      original: img.original
    }));

    // Cache the result for 24 hours
    searchCache.set(query, images);
    setTimeout(() => searchCache.delete(query), 24 * 60 * 60 * 1000);

    return images;
  } catch (error) {
    console.error("Error scraping SerpAPI images:", error);
    return [];
  }
};

// Rate limiter to prevent too many requests
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 10, // limit each IP to 10 requests per minute
  message: "Too many requests, please try again later.",
});

// Handle search form submissions
app.post('/search', limiter, async (req, res) => {
  let query = req.body.query;

  query = validator.escape(query);

  const sanitizedQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, '-');
  const filePath = path.join(__dirname, 'public/articles', `${sanitizedQuery}.html`);

  if (fs.existsSync(filePath)) {
    return res.redirect(`/articles/${sanitizedQuery}`);
  }

  try {
    const lookupResult = await scrapeSerpApiSearch(query);
    console.log("Scraped URLs:", lookupResult);

    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      const errorMsg = "No results found from SerpAPI. Please try a different query.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`);

      fs.writeFileSync(filePath, articleHtml);
      return res.redirect(`/articles/${sanitizedQuery}`);
    }

    const prompt = `You are Infintium. You have two purposes. If the user prompt is a math problem, solve it until it is COMPLETELY simplified. If it is a question, answer it with your own knowledge. If it is an item, such as a toaster, song, or anything that is a statement, act like Wikipedia and provide as much information as possible. USER PROMPT: ${query}`;

    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

    const urlList = lookupResult.map(url => `<li><a href="${url}" target="_blank">${url}</a></li>`).join('');
    console.log("Generated URL List:", urlList);
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    try {
      const images = await scrapeSerpApiImages(query);
      const imageGallery = images.length > 0
        ? images.map(img => `<img src="${img.thumbnail}" alt="${query} image">`).join('')
        : "No images available";

      articleHtml = articleHtml.replace(/{{imageGallery}}/g, imageGallery);

      fs.writeFileSync(filePath, articleHtml);
      res.redirect(`/articles/${sanitizedQuery}`);
    } catch (imageError) {
      console.error("Error generating the image gallery:", imageError);
      res.status(500).send("Error generating the image gallery.");
    }
  } catch (error) {
    console.error("Error during the search process:", error.message);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
});

// Serve suggestions for the autocomplete feature
app.get('/suggest', (req, res) => {
  const query = req.query.q.toLowerCase().replace(/-/g, ' ');
  const articlesDir = path.join(__dirname, 'public/articles');

  fs.readdir(articlesDir, (err, files) => {
    if (err) {
      return res.status(500).send([]);
    }

    const suggestions = files
      .filter(file => {
        const filename = file.replace('.html', '').toLowerCase();
        return filename.includes(query);
      })
      .map(file => file.replace('.html', ''));

    res.send(suggestions);
  });
});

// Serve the generated article pages or create them if they don't exist
// Serve the generated article pages or create them if they don't exist
app.get('/articles/:article', async (req, res) => {
  const article = req.params.article;
  const filePath = path.join(__dirname, 'public/articles', `${article}.html`);

  // Check if the file exists
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  try {
    // Convert the article name back to a readable format
    const query = article.replace(/-/g, ' '); 

    // Scrape information from SerpAPI
    const lookupResult = await scrapeSerpApiSearch(query);
    
    // Check if any results were found
    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      const errorMsg = "No content found for this article.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`);
      fs.writeFileSync(filePath, articleHtml);
      return res.sendFile(filePath);
    }

    // Generate a prompt for the AI content generation
    const prompt = `You are Infintium. You have two purposes. If the user prompt is a math problem, solve it until it is COMPLETELY simplified. If it is a question, answer it with your own knowledge. If it is an item, such as a toaster, song, or anything that is a statement, act like Wikipedia and provide as much information as possible. USER PROMPT: ${query}`;

    // Generate AI content using the prompt
    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    // Load the HTML template
    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');
    
    // Replace placeholders with the search query and AI content
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

    // Create a list of URLs for the article
    const urlList = lookupResult.map(url => `<li><a href="${url}" target="_blank">${url}</a></li>`).join('');
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    // Generate the image gallery in the article HTML
    try {
      const images = await scrapeSerpApiImages(query);
      
      // Check if images were fetched successfully
      const imageGallery = images.length > 0 
        ? images.map(img => `<img src="${img.original}" alt="${query} image" style="width: 200px; height: auto; margin: 5px;">`).join('')
        : '<p>No images available</p>';

      articleHtml = articleHtml.replace(/{{imageGallery}}/g, imageGallery);

      // Save the generated HTML file
      fs.writeFileSync(filePath, articleHtml);
      res.sendFile(filePath);
    } catch (imageError) {
      console.error("Error generating the image gallery:", imageError);
      res.status(500).send("Error generating the image gallery.");
    }
  } catch (error) {
    console.error("Error generating the article:", error);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
});


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
