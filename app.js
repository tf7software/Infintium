const express = require('express');
const fs = require('fs');
const path = require('path');
const markdown = require('markdown-it')();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const cheerio = require('cheerio');
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

  const apiKey = process.env.SERPAPI_API_KEY; // Add your SerpAPI key in the .env file
  const formattedQuery = encodeURIComponent(query);
  const url = `https://serpapi.com/search.json?q=${formattedQuery}&api_key=${apiKey}`;

  try {
    const { data } = await axios.get(url);

    // Check if the response contains the organic_results
    if (!data.organic_results || !Array.isArray(data.organic_results)) {
      console.error("No organic results found in the response.");
      return [];
    }

    const links = data.organic_results.map(result => result.link).filter(link => link && link.startsWith('http'));

    // Debug log to check the URLs collected
    console.log("Collected URLs:", links);

    // Cache the result for 24 hours
    searchCache.set(query, links);
    setTimeout(() => searchCache.delete(query), 24 * 60 * 60 * 1000); // Invalidate cache after 24 hours

    return links; // Return an array of links
  } catch (error) {
    console.error("Error scraping SerpAPI:", error);
    return []; // Return an empty array in case of error
  }
};

// Function to scrape images from SerpAPI
const scrapeSerpApiImages = async (query) => {
  if (searchCache.has(query)) {
    console.log("Serving images from cache");
    return searchCache.get(query);
  }

  const apiKey = process.env.SERPAPI_API_KEY; // Add your SerpAPI key in the .env file
  const url = `https://serpapi.com/search.json?engine=google_images&q=${query}&api_key=${apiKey}`;

  try {
    const { data } = await axios.get(url);
    const images = data.images_results.slice(0, 10).map(img => ({
      thumbnail: img.thumbnail,
      original: img.original
    }));

    // Cache the result for 24 hours
    searchCache.set(query, images);
    setTimeout(() => searchCache.delete(query), 24 * 60 * 60 * 1000); // Invalidate cache after 24 hours

    return images; // Return image objects (thumbnail and original)
  } catch (error) {
    console.error("Error scraping SerpAPI images:", error);
    return []; // Return an empty array in case of error
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

  // Sanitize user input using validator
  query = validator.escape(query);

  const sanitizedQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, '-');
  const filePath = path.join(__dirname, 'public/articles', `${sanitizedQuery}.html`);

  // Check if the article already exists
  if (fs.existsSync(filePath)) {
    return res.redirect(`/articles/${sanitizedQuery}`);
  }

  try {
    // Scrape information from SerpAPI
    const lookupResult = await scrapeSerpApiSearch(query);
    console.log("Scraped URLs:", lookupResult); // Log the scraped URLs

    // Ensure lookupResult is an array
    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      // Provide an error response and include a message
      const errorMsg = "No results found from SerpAPI. Please try a different query.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`); // Display error message in place of URLs

      fs.writeFileSync(filePath, articleHtml); // Save the HTML with error message
      return res.redirect(`/articles/${sanitizedQuery}`);
    }

    // Modify the prompt to instruct the AI
    const prompt = `You are Infintium. You have two purposes. If the user prompt is a math problem, solve it until it is COMPLETELY simplified. If it is a question, answer it with your own knowledge. If it is an item, such as a toaster, song, or anything that is a statement, act like Wikipedia and provide as much information as possible. USER PROMPT: ${query}`;

    // Generate AI content using the modified prompt
    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    // Load the HTML template
    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');

    // Replace placeholders with the search query and AI content
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);
    
    // Create a list of URLs for the article
    const urlList = lookupResult.map(url => `<li><a href="${url}" target="_blank">${url}</a></li>`).join('');
    console.log("Generated URL List:", urlList); // Log the generated URL list
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    // Save the generated HTML file
    fs.writeFileSync(filePath, articleHtml);

    // Redirect to the new article page
    res.redirect(`/articles/${sanitizedQuery}`);
  } catch (error) {
    console.error("Error during the search process:", error.message);
    res.status(500).send("An unexpected error occurred: " + error.message + "<br><pre>" + fs.readFileSync(__filename, 'utf8') + "</pre>"); // Send the JS file content
  }
});

// Serve suggestions for the autocomplete feature
app.get('/suggest', (req, res) => {
  const query = req.query.q.toLowerCase().replace(/-/g, ' '); // Treat dashes as spaces
  const articlesDir = path.join(__dirname, 'public/articles');

  // Read all files in the ARTICLES directory
  fs.readdir(articlesDir, (err, files) => {
    if (err) {
      return res.status(500).send([]);
    }

    // Filter files that match the query
    const suggestions = files
      .filter(file => {
        const filename = file.replace('.html', '').toLowerCase();
        return filename.includes(query); // Check against filename
      })
      .map(file => file.replace('.html', '')); // Remove .html extension

    res.send(suggestions);
  });
});

// Serve the generated article pages or create them if they don't exist
app.get('/articles/:article', async (req, res) => {
  const article = req.params.article;
  const filePath = path.join(__dirname, 'public/articles', `${article}.html`);

  // Check if the file exists
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  try {
    // If the file does not exist, generate the article content
    const query = article.replace(/-/g, ' '); // Convert the article name back to a readable format

    // Scrape information from SerpAPI
    const lookupResult = await scrapeSerpApiSearch(query);
    
    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      // If no results found, send an error page
      const errorMsg = "No content found for this article.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`);
      fs.writeFileSync(filePath, articleHtml);
      return res.sendFile(filePath);
    }

    // Modify the prompt to instruct the AI
    const prompt = `You are Infintium. You have two purposes. If the user prompt is a math problem, solve it until it is COMPLETELY simplified. If it is a question, answer it with your own knowledge. If it is an item, such as a toaster, song, or anything that is a statement, act like Wikipedia and provide as much information as possible. USER PROMPT: ${query}`;

    // Generate AI content
    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    // Load the HTML template
    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');

    // Replace placeholders with the search query and AI content
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

    try {
  const images = await scrapeSerpApiImages(query); // Scrape images for the article
  
  // Add this to the generated HTML for the image gallery
  const imageGallery = images.map(img => `<img src="${img.thumbnail}" alt="${query} image">`).join('');
  
  articleHtml = articleHtml.replace(/<!-- Images will be loaded here dynamically -->/g, imageGallery);

  // Save the generated HTML file
  fs.writeFileSync(filePath, articleHtml);
  
  res.sendFile(filePath);
} catch (error) {
  console.error("Error generating the article:", error);
  res.status(500).send("An unexpected error occurred: " + error.message);
}


    // Create a list of URLs for the article
    const urlList = lookupResult.map(url => `<li><a href="${url}" target="_blank">${url}</a></li>`).join('');
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    // Save the generated HTML file
    fs.writeFileSync(filePath, articleHtml);

    // Serve the newly created article
    res.sendFile(filePath);
  } catch (error) {
    console.error("Error generating the article:", error);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
