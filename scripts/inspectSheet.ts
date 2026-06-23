import path from 'path';
import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function inspect() {
  const credentialsPath = path.join(process.cwd(), 'google-credentials.json');
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  if (!spreadsheetId) {
    console.error('GOOGLE_SPREADSHEET_ID not found in .env.local');
    return;
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A1:Z1', // Get headers
    });
    console.log('Sheet Headers:', response.data.values);

    const rowsResponse = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: 'Sheet1!A2:Z5', // Get first few rows
    });
    console.log('Sample Row 1:', rowsResponse.data.values?.[0]);
  } catch (error: any) {
    console.error('Error reading spreadsheet:', error.message);
  }
}

inspect();
