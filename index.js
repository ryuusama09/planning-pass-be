require('dotenv').config();
const express = require('express');
const cors = require('cors');
const PDFDocument = require('pdfkit');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const port = process.env.PORT || 3001;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Configure nodemailer (you'll need to set up environment variables)
const transporter = nodemailer.createTransport({
  service: 'gmail', // or your email service
  auth: {
    user: process.env.EMAIL_USER, // your email
    pass: process.env.EMAIL_PASS, // your email password or app password
  },
});

// Verify email configuration on startup
console.log('📧 Email Configuration Check:');
console.log('   - Email Service:', 'gmail');
console.log('   - Email User:', process.env.EMAIL_USER ? '✅ Set' : '❌ Missing');
console.log('   - Email Pass:', process.env.EMAIL_PASS ? '✅ Set' : '❌ Missing');

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
    console.log('📬 Received form submission:', JSON.stringify(data, null, 2));

    // Basic guard
    if (!data || Object.keys(data).length === 0) {
      console.log('⚠️ Form submission rejected: No data provided.');
      return res.status(400).json({ error: 'No data provided' });
    }

    console.log('💾 Saving submission to database...');
    const submission = await Submission.create(data);
    console.log('✅ Submission saved with ID:', submission._id);

    // Send confirmation email
    console.log('📧 Preparing to send confirmation email...');
    await sendConfirmationEmail(data);

    return res.json({ message: 'Form saved successfully' });
  } catch (err) {
    console.error('❌ Error saving form data:', err);
    res.status(500).json({ error: 'Failed to save form data' });
  }
});

// Test email endpoint
app.get('/api/test-email', async (req, res) => {
  try {
    console.log('🧪 Testing email configuration...');
    
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.log('❌ Email test failed: Missing email credentials in .env');
      return res.status(500).json({ 
        error: 'Email configuration incomplete',
        details: {
          emailUser: !!process.env.EMAIL_USER,
          emailPass: !!process.env.EMAIL_PASS
        }
      });
    }

    const testMailOptions = {
      from: `"PlanningPass Test" <${process.env.EMAIL_USER}>`,
      to: process.env.EMAIL_USER, // Send test to yourself
      subject: 'PlanningPass Email Test',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px;">
          <h2>✅ Email Test Successful!</h2>
          <p>Your PlanningPass email configuration is working correctly.</p>
          <p><strong>Test Time:</strong> ${new Date().toLocaleString()}</p>
        </div>
      `,
    };

    console.log('✉️ Sending test email...');
    const info = await transporter.sendMail(testMailOptions);
    console.log('✅ Test email sent successfully! Message ID:', info.messageId);
    
    res.json({ 
      success: true, 
      message: 'Test email sent successfully',
      messageId: info.messageId 
    });
  } catch (error) {
    console.error('❌ Email test failed:', error);
    res.status(500).json({ 
      error: 'Email test failed',
      details: error.message 
    });
  }
});

// Helper function to send confirmation email
async function sendConfirmationEmail(formData) {
  console.log('📧 sendConfirmationEmail called with data:', {
    hasEmail: !!formData.email,
    email: formData.email,
    hasName: !!formData.name,
    name: formData.name,
    hasHomeType: !!formData.homeType,
    hasProjectType: !!formData.projectType,
    hasAddress: !!formData.address
  });

  if (!formData.email) {
    console.log('📧 Email not sent: No email address provided in form data.');
    return;
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.error('❌ Email not sent: Missing email credentials in environment variables');
    return;
  }

  const mailOptions = {
    from: `"PlanningPass" <${process.env.EMAIL_USER}>`,
    to: formData.email,
    subject: 'Planning Assessment Confirmation - PlanningPass',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #8b5cf6; margin: 0;">PlanningPass</h1>
          <p style="color: #666; margin: 5px 0;">Professional Planning Assessment</p>
        </div>
        
        <div style="background: #f8fafc; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h2 style="color: #1f2937; margin-top: 0;">Assessment Confirmation</h2>
          <p style="color: #374151;">Dear ${formData.name || 'Homeowner'},</p>
          <p style="color: #374151;">Thank you for submitting your planning assessment. We have received your request and our expert team will begin processing it immediately.</p>
        </div>
        
        <div style="margin-bottom: 30px;">
          <h3 style="color: #8b5cf6;">What happens next?</h3>
          <div style="margin: 20px 0;">
            <div style="display: flex; align-items: center; margin-bottom: 15px;">
              <div style="background: #8b5cf6; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; font-weight: bold;">1</div>
              <div>
                <strong style="color: #1f2937;">Expert Review (24 hours)</strong>
                <p style="margin: 5px 0; color: #6b7280;">Our qualified planning consultants will review your submission</p>
              </div>
            </div>
            <div style="display: flex; align-items: center; margin-bottom: 15px;">
              <div style="background: #8b5cf6; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; font-weight: bold;">2</div>
              <div>
                <strong style="color: #1f2937;">Detailed Analysis (48 hours)</strong>
                <p style="margin: 5px 0; color: #6b7280;">We'll prepare a comprehensive assessment with recommendations</p>
              </div>
            </div>
            <div style="display: flex; align-items: center; margin-bottom: 15px;">
              <div style="background: #8b5cf6; color: white; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-right: 15px; font-weight: bold;">3</div>
              <div>
                <strong style="color: #1f2937;">Report Delivery (72 hours)</strong>
                <p style="margin: 5px 0; color: #6b7280;">You'll receive your detailed planning report via email</p>
              </div>
            </div>
          </div>
        </div>
        
        <div style="background: #eff6ff; padding: 20px; border-radius: 8px; margin-bottom: 20px;">
          <h3 style="color: #1e40af; margin-top: 0;">Your Submission Details</h3>
          <p><strong>Property Type:</strong> ${formData.homeType || 'N/A'}</p>
          <p><strong>Project Type:</strong> ${formData.projectType || 'N/A'}</p>
          <p><strong>Property Address:</strong> ${formData.address || 'N/A'}</p>
          <p><strong>Reference ID:</strong> PPA-${Date.now().toString().slice(-6)}</p>
        </div>
        
        <div style="border-top: 1px solid #e5e7eb; padding-top: 20px; text-align: center;">
          <p style="color: #6b7280; margin-bottom: 10px;">Need help? Contact our planning experts:</p>
          <p style="color: #8b5cf6; font-weight: bold;">planning@planningpass.co.uk</p>
          <p style="color: #9ca3af; font-size: 12px; margin-top: 20px;">
            This is an automated confirmation. Please do not reply to this email.
          </p>
        </div>
      </div>
    `,
  };

  try {
    console.log(`✉️ Sending email to ${formData.email}...`);
    console.log(`📧 Email details: From "${mailOptions.from}" to "${mailOptions.to}"`);
    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Confirmation email sent successfully! Message ID:', info.messageId);
    console.log('📧 Email response:', {
      messageId: info.messageId,
      response: info.response,
      accepted: info.accepted,
      rejected: info.rejected
    });
  } catch (error) {
    console.error('❌ Error sending confirmation email:', error);
    console.error('📧 Email error details:', {
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode
    });
    // Optionally, re-throw the error if the caller needs to know about the failure
    // throw error;
  }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
