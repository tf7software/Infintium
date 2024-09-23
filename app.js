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
      const prompt = `You are Infintium if someone asks what Infintium is, provide a link to infintium.xyz/about.html (and for queries that have "Infintium" in the title, provide no other info besides the about page libk). you are like an AI wikipedia, give as much info as you can to whatever the user asks. Provide URLs that help the user search the subject on their own, like google searches (Like: https://www.google.com/search?q=Whatever+The+User+Wants+To+Know), and wikipedia pages. Also don't provide links if the prompt is an algebra/math problem or equation. USER PROMPT: ${query}`;

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
