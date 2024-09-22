const express = require('express');
const fs = require('fs');
const path = require('path');
const markdown = require('markdown-it')();
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
const PORT = 80;

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

// Handle search form submissions
app.post('/search', async (req, res) => {
  const query = req.body.query;
  const sanitizedQuery = query.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim().replace(/\s+/g, '-');
  const filePath = path.join(__dirname, 'public/articles', `${sanitizedQuery}.html`);

  // Check if the article already exists
  if (fs.existsSync(filePath)) {
    res.redirect(`/articles/${sanitizedQuery}`);
  } else {
    try {
      // Modify the prompt to instruct the AI
      const prompt = `You are Infintium, you are like an AI wikipedia, give as much info as you can to whatever the user asks. Maybe provide many sources to your info, and make sure they are actual sources, not 404 pages. USER PROMPT: ${query}`;

      // Generate AI content using the modified prompt
      const result = await model.generateContent(prompt);
      const markdownContent = markdown.render(result.response.text());

      // Load the HTML template
      let articleHtml = fs.readFileSync(path.join(__dirname, 'views/template.html'), 'utf8');

      // Replace placeholders with the search query and AI content
      articleHtml = articleHtml.replace(/{{title}}/g, query);
      articleHtml = articleHtml.replace(/{{content}}/g, markdownContent);

      // Save the generated HTML file
      fs.writeFileSync(filePath, articleHtml);

      // Redirect to the new article page
      res.redirect(`/articles/${sanitizedQuery}`);
    } catch (error) {
      console.error("Error generating content:", error);
      res.status(500).send("Something went wrong. Please try again later.");
    }
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
