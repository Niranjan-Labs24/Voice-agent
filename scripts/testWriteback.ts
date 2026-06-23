import path from 'path';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import { fetchCustomerData, updateCustomerRow } from '../src/sheets.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

async function insertTestRow() {
  const credentialsPath = path.join(process.cwd(), 'google-credentials.json');
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const spreadsheetId = process.env.GOOGLE_SPREADSHEET_ID;

  // Row 2 values aligned with user's new headers:
  // Col A: Attempts, Col B: Status, Col C: LastCallAt, Col D: Disposition, Col E: Consent,
  // Col F: PhoneNumber, Col G: Name, Col H: Language, Col I: PuposeOfCalling, Col J: CallHistory
  const values = [['0', 'Pending', '', '', '', '919499459316', 'Ayush', 'Hindi', 'Kyc is not complete', 'None']];
  
  console.log('✍️ Inserting test row to Sheet1!A2:J2...');
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: 'Sheet1!A2:J2',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
  console.log('✅ Test row inserted.');
}

async function runTest() {
  const testPhone = '919499459316';
  
  console.log(`🔍 Checking customer data for ${testPhone}...`);
  let customer = await fetchCustomerData(testPhone);
  
  if (!customer) {
    console.log('⚠️ Customer not found. Inserting a test row first...');
    await insertTestRow();
    customer = await fetchCustomerData(testPhone);
  }
  
  if (!customer) {
    console.error('❌ Failed to fetch customer data even after insertion.');
    return;
  }
  
  console.log('✅ Customer data fetched:', customer);

  const testTranscript = `Agent: Hello, am I speaking with Ayush?
Customer: Haan, bol raha hoon. Kaun?
Agent: Main HDFC Bank se baat kar rahi hoon. Aapka KYC complete nahi hua hai, isliye call kiya tha. Aap isse mobile app ya branch se complete kar sakte hain.
Customer: Achha theek hai, main mobile app se complete kar loonga.
Agent: Dhanyavaad, goodbye.
Customer: Goodbye.`;

  console.log('\n🧠 Generating structured call outcome using post-call Gemini agent...');
  const { analyzeCallAndGenerateOutcome } = await import('../src/summarizer.js');
  const outcome = await analyzeCallAndGenerateOutcome(testTranscript);
  console.log('Generated call outcome:', JSON.stringify(outcome, null, 2));
  
  console.log(`\n✍️ Testing writeback to row ${customer.rowNumber}...`);
  await updateCustomerRow(customer.rowNumber, outcome);
  
  console.log('\n🔍 Re-fetching customer data to check updated attempts...');
  const updatedCustomer = await fetchCustomerData(testPhone);
  console.log('✅ Re-fetched customer data:', updatedCustomer);
}

runTest();
