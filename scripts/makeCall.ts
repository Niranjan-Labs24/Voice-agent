import { SipClient } from 'livekit-server-sdk';
import dotenv from 'dotenv';
import path from 'path';
import { fetchCustomerData } from '../src/sheets.js';

dotenv.config({ path: path.join(process.cwd(), '.env.local') });

const url = process.env.LIVEKIT_URL;
const key = process.env.LIVEKIT_API_KEY;
const secret = process.env.LIVEKIT_API_SECRET;

const sipClient = new SipClient(url!, key!, secret!);

async function makeCall() {
  const toNumber = process.argv[2];
  
  if (!toNumber) {
    console.error('Error: Please provide a phone number to call.');
    console.log('Usage: npm run call <phone_number>');
    process.exit(1);
  }

  // Get your SIP Trunk ID from your LiveKit Cloud dashboard (or use the env variable)
  const sipTrunkId = process.env.SIP_TRUNK_ID || 'ST_XXXXXXXXXXXXXXXXX';
  const roomName = 'pre-' + Math.floor(Math.random() * 100000);

  try {
    console.log(`Fetching Google Sheets data for ${toNumber}...`);
    const customerData = await fetchCustomerData(toNumber);
    
    // Map language string to LiveKit language code
    let langCode = 'en-IN';
    if (customerData?.language.toLowerCase().includes('hindi')) langCode = 'hi-IN';
    if (customerData?.language.toLowerCase().includes('tamil')) langCode = 'ta-IN';

    if (!customerData) {
      console.log(`\n⚠️  WARNING: Phone number "${toNumber}" was NOT found in the Google Sheet.`);
      console.log(`Using default fallback metadata: Name="Customer", Language="English", Purpose="General Inquiry".\n`);
    }

    const metadata = customerData ? {
      language: langCode,
      phone_number: toNumber,
      row_number: customerData.rowNumber,
      variables: {
        customer_name: customerData.name,
        phone_number: toNumber,
        language: customerData.language,
        purpose: customerData.purpose,
        call_history: customerData.callHistory
      }
    } : {
      // Fallback if not found or no credentials
      language: "en-IN",
      phone_number: toNumber,
      row_number: undefined,
      variables: {
        customer_name: "Customer",
        phone_number: toNumber,
        language: "English",
        purpose: "General Inquiry",
        call_history: "None"
      }
    };

    console.log(`Connecting to LiveKit...`);
    console.log(`Calling ${toNumber} in room ${roomName}...`);

    // 1. Create the Room & Invite the Phone Number
    await sipClient.createSipParticipant(sipTrunkId, toNumber, roomName, {
      participantIdentity: 'caller-1',
      participantName: 'Outbound Call',
      playDialtone: true,
      waitUntilAnswered: false,
    });
    
    // 2. Explicitly tell LiveKit to send the Agent into this room
    const { AgentDispatchClient } = await import('livekit-server-sdk');
    const dispatchClient = new AgentDispatchClient(url!, key!, secret!);
    await dispatchClient.createDispatch(roomName, 'my-agent', {
      metadata: JSON.stringify(metadata)
    });

    console.log('✅ Call initiated and Agent dispatched successfully!');
    console.log('✅ Injected Metadata:', metadata.variables);
    console.log('Please join the room in your LiveKit Sandbox to observe the agent.');
  } catch (error) {
    console.error('❌ Failed to make call:', error);
  }
}

makeCall();
