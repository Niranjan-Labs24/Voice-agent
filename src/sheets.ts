import path from 'path';
import dotenv from 'dotenv';
import { google } from 'googleapis';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;
const RANGE_HEADERS = 'Sheet1!A1:Z1';
const RANGE_DATA = 'Sheet1!A2:Z';

function getColLetter(index: number): string {
  let temp = '';
  let idx = index;
  while (idx >= 0) {
    temp = String.fromCharCode((idx % 26) + 65) + temp;
    idx = Math.floor(idx / 26) - 1;
  }
  return temp;
}

function cleanHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s\-_]/g, '');
}

async function getSheetsClient() {
  const credentialsPath = path.join(process.cwd(), 'google-credentials.json');
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'], // Read-write scope
  });
  return google.sheets({ version: 'v4', auth });
}

export interface CustomerData {
  rowNumber: number;
  phoneNumber: string;
  name: string;
  language: string;
  purpose: string;
  callHistory: string;
  attempts: number;
}

export interface CallOutcome {
  disposition: string;
  call_status: string;
  summary: string;
  next_action?: string;
  consent?: 'Y' | 'N' | 'U';
  callHistory?: string;
}

/**
 * Fetches customer data from the sheet by phone number.
 * Automatically aligns with dynamic headers.
 */
export async function fetchCustomerData(phoneNumber: string): Promise<CustomerData | null> {
  if (!SPREADSHEET_ID) {
    console.warn('⚠️ GOOGLE_SPREADSHEET_ID is not configured.');
    return null;
  }

  try {
    const sheets = await getSheetsClient();
    
    // 1. Get headers
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_HEADERS,
    });
    
    const headers = headerResponse.data.values?.[0] || [];
    if (headers.length === 0) {
      console.warn('⚠️ Google Sheet has no headers.');
      return null;
    }

    // Identify indices
    const cleanHeaders = headers.map(cleanHeader);
    const phoneIdx = cleanHeaders.findIndex(h => h === 'phonenumber' || h === 'mobile');
    const nameIdx = cleanHeaders.findIndex(h => h === 'name' || h === 'customername');
    const langIdx = cleanHeaders.findIndex(h => h === 'language');
    const purposeIdx = cleanHeaders.findIndex(h => h === 'purpose' || h === 'scenario' || h.includes('purpose') || h.includes('pupose'));
    const historyIdx = cleanHeaders.findIndex(h => h === 'history' || h === 'callhistory' || h === 'reflast4');
    const attemptsIdx = cleanHeaders.findIndex(h => h === 'attempts');

    if (phoneIdx === -1) {
      console.error('❌ Could not find phone number / mobile column in Sheet headers.');
      return null;
    }

    // 2. Get data
    const dataResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_DATA,
    });

    const rows = dataResponse.data.values || [];
    const targetPhone = phoneNumber.replace('+', '').trim();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const rowPhone = (row[phoneIdx] || '').toString().replace('+', '').trim();
      if (rowPhone === targetPhone) {
        const attemptsVal = attemptsIdx !== -1 ? parseInt(row[attemptsIdx] || '') : 0;
        return {
          rowNumber: i + 2, // 1-indexed, account for header row
          phoneNumber: row[phoneIdx] || '',
          name: nameIdx !== -1 ? row[nameIdx] || 'Customer' : 'Customer',
          language: langIdx !== -1 ? row[langIdx] || 'English' : 'English',
          purpose: purposeIdx !== -1 ? row[purposeIdx] || 'General' : 'General',
          callHistory: historyIdx !== -1 ? row[historyIdx] || 'None' : 'None',
          attempts: isNaN(attemptsVal) ? 0 : attemptsVal,
        };
      }
    }

    console.warn(`⚠️ Phone number ${phoneNumber} not found in the sheet.`);
    return null;
  } catch (error: any) {
    console.error('Error fetching customer from sheets:', error.message);
    return null;
  }
}

/**
 * Updates call results in the customer row.
 * Missing columns are appended dynamically.
 */
export async function updateCustomerRow(rowNumber: number, outcome: CallOutcome) {
  if (!SPREADSHEET_ID) {
    console.warn('⚠️ GOOGLE_SPREADSHEET_ID is not configured.');
    return;
  }

  try {
    const sheets = await getSheetsClient();
    
    // 1. Get headers to find indices or append new ones
    const headerResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE_HEADERS,
    });
    
    let headers = headerResponse.data.values?.[0] || [];
    let cleanHeaders = headers.map(cleanHeader);

    // Target columns we want to make sure exist
    const targetCols = ['attempts', 'status', 'disposition', 'lastcallat', 'notes', 'consent', 'callhistory'];
    const colNameMap: Record<string, string> = {
      attempts: 'Attempts',
      status: 'Status',
      disposition: 'Disposition',
      lastcallat: 'LastCallAt',
      notes: 'Notes',
      consent: 'Consent',
      callhistory: 'CallHistory',
    };

    const newHeadersToAppend: string[] = [];
    for (const tc of targetCols) {
      const colName = colNameMap[tc];
      if (colName && !cleanHeaders.includes(tc)) {
        newHeadersToAppend.push(colName);
      }
    }

    // Append new headers if missing
    if (newHeadersToAppend.length > 0) {
      console.log(`Appending missing headers: ${newHeadersToAppend.join(', ')}`);
      const nextColIdx = headers.length;
      const startLetter = getColLetter(nextColIdx);
      const endLetter = getColLetter(nextColIdx + newHeadersToAppend.length - 1);
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!${startLetter}1:${endLetter}1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [newHeadersToAppend],
        },
      });

      // Refresh headers list
      const refreshedHeaderResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: RANGE_HEADERS,
      });
      headers = refreshedHeaderResponse.data.values?.[0] || [];
      cleanHeaders = headers.map(cleanHeader);
    }

    // Get indices again
    const attemptsIdx = cleanHeaders.indexOf('attempts');
    const statusIdx = cleanHeaders.indexOf('status');
    const dispositionIdx = cleanHeaders.indexOf('disposition');
    const lastCallIdx = cleanHeaders.indexOf('lastcallat');
    const notesIdx = cleanHeaders.indexOf('notes');
    const consentIdx = cleanHeaders.indexOf('consent');
    const historyIdx = cleanHeaders.indexOf('callhistory');

    // 2. Fetch current attempts count
    let currentAttempts = 0;
    if (attemptsIdx !== -1) {
      const attemptsLetter = getColLetter(attemptsIdx);
      const attemptsResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `Sheet1!${attemptsLetter}${rowNumber}`,
      });
      const val = parseInt(attemptsResponse.data.values?.[0]?.[0] || '0');
      currentAttempts = isNaN(val) ? 0 : val;
    }

    const updates: { range: string; values: any[][] }[] = [];

    // Increment Attempts
    if (attemptsIdx !== -1) {
      updates.push({
        range: `Sheet1!${getColLetter(attemptsIdx)}${rowNumber}`,
        values: [[currentAttempts + 1]],
      });
    }

    // Update Status
    if (statusIdx !== -1) {
      updates.push({
        range: `Sheet1!${getColLetter(statusIdx)}${rowNumber}`,
        values: [[outcome.call_status]],
      });
    }

    // Update Disposition
    if (dispositionIdx !== -1) {
      updates.push({
        range: `Sheet1!${getColLetter(dispositionIdx)}${rowNumber}`,
        values: [[outcome.disposition]],
      });
    }

    // Update LastCallAt
    if (lastCallIdx !== -1) {
      updates.push({
        range: `Sheet1!${getColLetter(lastCallIdx)}${rowNumber}`,
        values: [[new Date().toISOString()]],
      });
    }

    // Update Notes (Summary + Next Action)
    if (notesIdx !== -1) {
      const notesContent = `${outcome.summary}${outcome.next_action ? ` | Next: ${outcome.next_action}` : ''}`;
      updates.push({
        range: `Sheet1!${getColLetter(notesIdx)}${rowNumber}`,
        values: [[notesContent]],
      });
    }

    // Update Consent
    if (consentIdx !== -1 && outcome.consent) {
      updates.push({
        range: `Sheet1!${getColLetter(consentIdx)}${rowNumber}`,
        values: [[outcome.consent]],
      });
    }

    // Update Call History
    if (historyIdx !== -1 && outcome.callHistory) {
      updates.push({
        range: `Sheet1!${getColLetter(historyIdx)}${rowNumber}`,
        values: [[outcome.callHistory]],
      });
    }

    // Perform batch update
    if (updates.length > 0) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          data: updates.map(u => ({
            range: u.range,
            values: u.values,
          })),
          valueInputOption: 'USER_ENTERED',
        },
      });
      console.log(`✅ Successfully updated row ${rowNumber} with outcome: ${outcome.disposition}`);
    }
  } catch (error: any) {
    console.error(`❌ Failed to update row ${rowNumber}:`, error.message);
  }
}
