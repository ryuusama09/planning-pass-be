require('dotenv').config();
const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');

const app = express();
const port = process.env.PORT || 3001;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Connect to MongoDB
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Define a flexible schema to store any form fields
const submissionSchema = new mongoose.Schema({}, { strict: false, timestamps: true });
const Submission = mongoose.model('Submission', submissionSchema);

app.use(cors());
app.use(express.json());

// Helper function to validate the new questionnaire structure
function validateQuestionnaireData(data) {
  const requiredFields = [
    'homeType',
    'projectType',
    'sketch',
    'address',
    'postcode',
    'name',
    'email'
  ];
  for (const field of requiredFields) {
    if (!data[field] || (typeof data[field] === 'object' && Object.keys(data[field]).length === 0)) {
      return `Missing required field: ${field}`;
    }
  }
  return null;
}

// Helper function to generate report content using Gemini
async function generateReportContent(questionnaireData) {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Extract fields for clarity
  const { homeType, projectType, designatedAreas, sketch, address, postcode, name, phone, email } = questionnaireData;

  const prompt = `Generate a UK planning permission report based on the following data. Use the structure below. If any field is missing, note it in the report.

Property Details
- Address: ${address || '[Not provided]'}
- Postcode: ${postcode || '[Not provided]'}
- Name: ${name || '[Not provided]'}
- Email: ${email || '[Not provided]'}
- Phone: ${phone || '[Not provided]'}

Project Details
- Property Type: ${homeType || '[Not provided]'}
- Project Type: ${projectType || '[Not provided]'}
- Designated Areas: ${designatedAreas ? Object.keys(designatedAreas).filter(k => designatedAreas[k]).join(', ') : '[Not provided]'}
- Project Specification: ${sketch ? JSON.stringify(sketch, null, 2) : '[Not provided]'}

---

Report Template:
📅 Generated on: [Current Date]
🏡 Property Address: [Address]
🏛 Postcode: [Postcode]
👤 Name: [Name]
✉️ Email: [Email]
📞 Phone: [Phone]

Project Summary
Property Type: [Type]
Project Type: [Type]
Designated Areas: [Areas]
Project Specification:
[Summarise the key dimensions/specification]

Planning Assessment
Item Tested | Proposal | Standard | Result
[Assessment items in table format with ✅, ❗, or ❌]

Interpretation & Actions
[Interpretation of results and recommended actions]

Must-Do Checklist
• [List of must-do items with bullet points]

Official Rules Explained
[Relevant planning rules and regulations]

Disclaimer
This report is based solely on the information you provided. It is informal advice based on national planning rules and does not constitute a formal legal decision. You should confirm details with your Local Planning Authority before beginning work.`;

  const result = await model.generateContent(prompt);
  const response = await result.response;
  return response.text();
}

// Helper function to generate PDF
function generatePDF(reportContent) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks = [];

    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Add header with date and property info
    doc.fontSize(12);
    const headerLines = reportContent.split('\n').slice(0, 3);
    headerLines.forEach(line => {
      doc.text(line, { align: 'left' });
    });
    doc.moveDown();

    // Split content by sections
    const sections = reportContent.split('\n\n');
    sections.forEach(section => {
      if (!section.trim()) return;

      // Handle table sections
      if (section.includes('|')) {
        const rows = section.split('\n');
        const headers = rows[0].split('|').map(h => h.trim());
        const data = rows.slice(1).map(row => row.split('|').map(cell => cell.trim()));

        // Add table headers
        doc.fontSize(12).font('Helvetica-Bold');
        headers.forEach((header, i) => {
          doc.text(header, 50 + (i * 100), doc.y, { width: 100 });
        });
        doc.moveDown();

        // Add table data
        doc.fontSize(10).font('Helvetica');
        data.forEach(row => {
          row.forEach((cell, i) => {
            doc.text(cell, 50 + (i * 100), doc.y, { width: 100 });
          });
          doc.moveDown();
        });
      }
      // Handle checklist sections
      else if (section.includes('•')) {
        const [title, ...items] = section.split('\n');
        doc.fontSize(12).font('Helvetica-Bold').text(title);
        doc.moveDown();
        doc.fontSize(10).font('Helvetica');
        items.forEach(item => {
          doc.text('• ' + item.trim().replace('•', ''), { indent: 20 });
        });
      }
      // Handle regular sections
      else {
        const [title, ...content] = section.split('\n');
        doc.fontSize(12).font('Helvetica-Bold').text(title);
        doc.moveDown();
        doc.fontSize(10).font('Helvetica');
        content.forEach(line => {
          doc.text(line);
        });
      }
      doc.moveDown(2);
    });

    // Add footer
    doc.fontSize(10)
       .text('Automated Planning Report generated by Your Brand, ' + new Date().toLocaleString(), {
         align: 'center'
       })
       .text('No legal liability is accepted; homeowners should verify with their local planning authority.', {
         align: 'center'
       });

    doc.end();
  });
}

// Report generation endpoint
app.post('/api/generate-report', async (req, res) => {
  try {
    const questionnaireData = req.body;

    // Validate required fields
    const validationError = validateQuestionnaireData(questionnaireData);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    // Generate report content using Gemini
    const reportContent = await generateReportContent(questionnaireData);

    // Generate PDF
    const pdfBuffer = await generatePDF(reportContent);

    // Send both the content and PDF
    res.json({
      content: reportContent,
      pdf: pdfBuffer.toString('base64')
    });
  } catch (error) {
    console.error('Error generating report:', error);
    res.status(500).json({ error: 'Failed to generate report' });
  }
});
app.get("/",(req,res)=>{
  res.send("Hello World , server functioning !")
})
// Endpoint to save form submissions
app.post('/api/submit-form', async (req, res) => {
  try {
    const data = req.body;

    // Basic guard
    if (!data || Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No data provided' });
    }

    await Submission.create(data);

    return res.json({ message: 'Form saved successfully' });
  } catch (err) {
    console.error('Error saving form data:', err);
    res.status(500).json({ error: 'Failed to save form data' });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
