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

app.get('/pacman', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/pacman.html'));
});

app.get('/slope', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/slope.html'));
});

app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/about.html'));
});

app.get('/view', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/view.html'));
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

// Function to scrape search results from ScrAPI
const scrapeScrAPI = async (query) => {
  if (searchCache.has(query)) {
    console.log("Serving from cache");
    return searchCache.get(query);
  }

  const formattedQuery = encodeURIComponent(query);
  const url = `https://scrapi.pythonanywhere.com/search?q=${formattedQuery}&n=10`;

  try {
    const { data } = await axios.get(url);

    // Check if the response format contains 'results'
    if (!data.results || !Array.isArray(data.results)) {
      console.error("No results found in the response.");
      return [];
    }

    // Map over the results and extract the 'link' attribute
    const links = data.results.map(result => result.link).filter(link => link && link.startsWith('http'));
    console.log("Collected URLs:", links);

    // Cache the result for 24 hours
    searchCache.set(query, links);
    setTimeout(() => searchCache.delete(query), 24 * 60 * 60 * 1000);

    return links;
  } catch (error) {
    console.error("Error scraping ScrAPI:", error);
    return [];
  }
};


// Rate limiter to prevent too many requests
const limiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute window
  max: 10, // limit each IP to 10 requests per minute
  message: "Too many requests, please try again later.",
});

app.post('/search', limiter, async (req, res) => {
  let query = req.body.query;

  // Escape user input to prevent XSS attacks
  query = validator.escape(query);

  // Sanitize the query for use in filenames and URLs
  const sanitizedQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, '-');
  const filePath = path.join(__dirname, 'public/articles', `${sanitizedQuery}.html`);

  // Check if the file already exists
  if (fs.existsSync(filePath)) {
    return res.redirect(`/articles/${sanitizedQuery}`);
  }

  try {
    // Scrape URLs using ScrAPI
    const lookupResult = await scrapeScrAPI(query);
    console.log("Scraped URLs:", lookupResult);

    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      const errorMsg = "No results found from ScrAPI. Please try a different query.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`);

      fs.writeFileSync(filePath, articleHtml);
      return res.redirect(`/articles/${sanitizedQuery}`);
    }

    // Define mathematical symbols to check for
    const mathSymbols = /[+\=\*\^√≥≤π]/;

    // Append the scraped links to the prompt
    const formattedLinks = lookupResult.map(url => `\n- ${url}`).join('');
    const prompt = `You are Infintium. You have two purposes. If the user prompt is a math problem, solve it until it is COMPLETELY simplified. If it is a question, answer it with your own knowledge. If it is an item, such as a toaster, song, or anything that is a statement, act like Wikipedia and provide as much information as possible. USER PROMPT: ${query}. Here are some references you may find helpful (Never metion these links): ${formattedLinks}`;

    // Generate content using the AI model
    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

    // Check if the query contains math symbols
    if (mathSymbols.test(query)) {
      // Replace the "Further reading" section with "No further reading - Math"
      articleHtml = articleHtml.replace(/{{urls}}/g, '<li>No further reading - Math</li>');
    } else {
      // Generate the URL list if no math symbols are present
      const urlList = lookupResult.map(url => `<li><a href="${url}" target="_blank">${url}</a></li>`).join('');
      articleHtml = articleHtml.replace(/{{urls}}/g, urlList);
    }

    // Write the generated HTML to a file
    fs.writeFileSync(filePath, articleHtml);
    res.redirect(`/articles/${sanitizedQuery}`);
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
app.get('/articles/:article', async (req, res) => {
  const article = req.params.article;
  const filePath = path.join(__dirname, 'public/articles', `${article}.html`);

  // Check if the file exists
  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  try {
    const query = article.replace(/-/g, ' ');

    const lookupResult = await scrapeScrAPI(query);
    
    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      const errorMsg = "No content found for this article.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`);
      fs.writeFileSync(filePath, articleHtml);
      return res.sendFile(filePath);
    }

    const prompt = `You are Infintium. You have two purposes. If the user prompt is a math problem, solve it until it is COMPLETELY simplified. If it is a question, answer it with your own knowledge. If it is an item, such as a toaster, song, or anything that is a statement, act like Wikipedia and provide as much information as possible. USER PROMPT: ${query}`;

    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');
    
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

    const urlList = lookupResult.map(url => `<li><a href="${url}" target="_blank">${url}</a></li>`).join('');
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    fs.writeFileSync(filePath, articleHtml);
    res.sendFile(filePath);
  } catch (error) {
    console.error("Error generating the article:", error);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
