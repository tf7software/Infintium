const express = require('express');
const fs = require('fs');
const path = require('path');
const markdown = require('markdown-it')();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const rateLimit = require('express-rate-limit');
const validator = require('validator');
const { exec } = require('child_process'); // Import child_process to execute Python scripts
require('dotenv').config();

const app = express();
const PORT = 80;

// Run setup script to ensure Python and libraries are installed
exec('bash setup.sh', (error, stdout, stderr) => {
    if (error) {
        console.error(`Error executing setup script: ${error.message}`);
        return;
    }
    if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
    }
    console.log(`stdout: ${stdout}`);
});


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

app.get('/view', (req, res) => {
  res.sendFile(path.join(__dirname, 'views/view.html'));
});

// Serve snake game
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

// Function to scrape search results using scrape.py
const scrapePySearch = (query) => {
  return new Promise((resolve, reject) => {
    const sanitizedQuery = query.replace(/[^a-zA-Z0-9 ]/g, ''); // sanitize query for shell
    exec(`python3 scrape.py "${sanitizedQuery}" 10`, (error, stdout, stderr) => { // Limit to 10 results
      if (error) {
        console.error(`Error executing Python script: ${error.message}`);
        reject(error);
      }
      if (stderr) {
        console.error(`stderr from Python script: ${stderr}`);
      }

      try {
        const results = JSON.parse(stdout);
        resolve(results);
      } catch (parseError) {
        console.error(`Error parsing Python script output: ${parseError.message}`);
        reject(parseError);
      }
    });
  });
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
    // Fetch results from scrape.py
    const lookupResult = await scrapePySearch(query);
    console.log("Scraped URLs:", lookupResult);

    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      const errorMsg = "No results found. Please try a different query.";
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

    const urlList = lookupResult.map(url => `<li><a href="${url.link}" target="_blank">${url.title}</a></li>`).join('');
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    // Removed image gallery code

    fs.writeFileSync(filePath, articleHtml);
    res.redirect(`/articles/${sanitizedQuery}`);
  } catch (error) {
    console.error("Error during the search process:", error.message);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
});

// Serve the generated article pages or create them if they don't exist
app.get('/articles/:article', async (req, res) => {
  const article = req.params.article;
  const filePath = path.join(__dirname, 'public/articles', `${article}.html`);

  if (fs.existsSync(filePath)) {
    return res.sendFile(filePath);
  }

  try {
    const query = article.replace(/-/g, ' ');

    const lookupResult = await scrapePySearch(query);
    
    if (!Array.isArray(lookupResult) || lookupResult.length === 0) {
      const errorMsg = "No content found for this article.";
      const articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8')
        .replace(/{{title}}/g, query)
        .replace(/{{content}}/g, "No content generated as there were no URLs.")
        .replace(/{{urls}}/g, `<li>${errorMsg}</li>`);
      fs.writeFileSync(filePath, articleHtml);
      return res.sendFile(filePath);
    }

    const prompt = `You are Infintium. You have two purposes... USER PROMPT: ${query}`;
    const result = await model.generateContent(prompt);
    const markdownContent = markdown.render(result.response.text());

    let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');
    articleHtml = articleHtml.replace(/{{title}}/g, query);
    articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

    const urlList = lookupResult.map(url => `<li><a href="${url.link}" target="_blank">${url.title}</a></li>`).join('');
    articleHtml = articleHtml.replace(/{{urls}}/g, urlList);

    // Removed image gallery code

    fs.writeFileSync(filePath, articleHtml);
    res.sendFile(filePath);
  } catch (error) {
    console.error("Error during the article generation process:", error.message);
    res.status(500).send("An unexpected error occurred: " + error.message);
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
