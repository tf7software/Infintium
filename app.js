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

// Function to scrape search results from Google
const scrapeGoogleSearch = async (query) => {
  if (searchCache.has(query)) {
    console.log("Serving from cache");
    return searchCache.get(query);
  }

  const formattedQuery = encodeURIComponent(query);
  const url = `https://www.google.com/search?q=${formattedQuery}`;

  try {
    const { data } = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.121 Safari/537.36'
      }
    });

    const $ = cheerio.load(data);
    const links = [];

    $('a').each((index, element) => {
      const link = $(element).attr('href');
      
      // Find classic Google links
      if (link && link.startsWith('/url?q=')) {
        const actualLink = link.split('/url?q=')[1].split('&')[0];
        const decodedLink = decodeURIComponent(actualLink);
        if (decodedLink.startsWith('http')) {
          links.push(decodedLink);
        }
      }

      // Stop after collecting 10 URLs
      if (links.length >= 10) {
        return false; // Break the loop when we have 10 links
      }
    });

    // Cache the result for 24 hours
    searchCache.set(query, links); // Store the actual links
    setTimeout(() => searchCache.delete(query), 24 * 60 * 60 * 1000); // Invalidate cache after 24 hours

    return links; // Return an array of links
  } catch (error) {
    console.error("Error scraping Google:", error);
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
    // Scrape information before generating the content
    const lookupResult = await scrapeGoogleSearch(query);
    console.log("Scraped URLs:", lookupResult);

    // Ensure lookupResult is an array
    if (!Array.isArray(lookupResult)) {
      return res.status(404).send("No results found. Please try another query.");
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
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    // Save the generated HTML file
    fs.writeFileSync(filePath, articleHtml);

    // Redirect to the new article page
    res.redirect(`/articles/${sanitizedQuery}`);
  } catch (error) {
    console.error("Error during the search process:", error.message);
    res.status(500).send("An unexpected error occurred: " + error.message);
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

// Serve the generated article pages
app.get('/articles/:article', (req, res) => {
  const article = req.params.article;
  const filePath = path.join(__dirname, 'public/articles', `${article}.html`);

  // Check if the file exists
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.redirect('/');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
