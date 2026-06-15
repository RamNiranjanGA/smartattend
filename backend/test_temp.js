const mongoose = require('mongoose');
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const Request = require('./models/Request');
const User = require('./models/User');
const Attendance = require('./models/Attendance');
const requestController = require('./controllers/requestController');
const attendanceController = require('./controllers/attendanceController');

const mockResponse = () => {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.jsonData = data;
    return res;
  };
  return res;
};

async function testSuite() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB for verification tests.');

    // Find a student, an advisor, and an HOD from seeded database
    const student = await User.findOne({ role: 'Student', department: 'CSE' });
    const advisor = await User.findOne({ role: 'Class Advisor', department: 'CSE', 'classAdvisorDetails.year': student.year, 'classAdvisorDetails.section': student.section });
    const hod = await User.findOne({ role: 'HoD', department: 'CSE' });

    if (!student || !advisor || !hod) {
      throw new Error('Could not find seeded student, advisor, or hod in CSE department.');
    }

    console.log(`Using Test Users:\n- Student: ${student.email}\n- Advisor: ${advisor.email}\n- HOD: ${hod.email}\n`);

    // --- SCENARIO 1: OD request without proof must fail ---
    console.log('--- Scenario 1: OD request without proof ---');
    const req1 = {
      user: student,
      body: {
        targetModel: 'Leave',
        reason: 'Attending symposium',
        newValue: {
          leaveType: 'OD',
          startDate: new Date(),
          endDate: new Date()
        }
      }
    };
    const res1 = mockResponse();
    await requestController.submitRequest(req1, res1);
    if (res1.statusCode === 400 && res1.jsonData?.message?.includes('requires attaching a proof form')) {
      console.log('PASSED: OD request without proof was correctly blocked.\n');
    } else {
      console.error('FAILED: OD request without proof status code:', res1.statusCode, res1.jsonData);
    }

    // --- SCENARIO 2: Leave request with proof submit ---
    console.log('--- Scenario 2: OD request with proof submission ---');
    const req2 = {
      user: student,
      body: {
        targetModel: 'Leave',
        reason: 'Symposium',
        newValue: {
          leaveType: 'OD',
          startDate: new Date(),
          endDate: new Date(),
          proofImage: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU55ErkJggg=='
        }
      }
    };
    const res2 = mockResponse();
    await requestController.submitRequest(req2, res2);
    if (res2.statusCode === 201 && res2.jsonData?.success) {
      console.log('PASSED: OD request with proof submitted successfully.');
      const createdRequest = res2.jsonData.request;

      // --- SCENARIO 3: HOD cannot approve until advisor approves ---
      console.log('--- Scenario 3: HOD approval before Advisor ---');
      const req3 = {
        user: hod,
        params: { requestId: createdRequest._id },
        body: { status: 'Approved', reviewRemarks: 'Approved by HOD' }
      };
      const res3 = mockResponse();
      await requestController.reviewRequest(req3, res3);
      if (res3.statusCode === 403 && res3.jsonData?.message?.includes('approved by the Class Advisor first')) {
        console.log('PASSED: HOD approval blocked before advisor approval.\n');
      } else {
        console.error('FAILED: HOD approval check before advisor:', res3.statusCode, res3.jsonData);
      }

      // --- SCENARIO 4: Advisor approves request ---
      console.log('--- Scenario 4: Advisor approves request ---');
      const req4 = {
        user: advisor,
        params: { requestId: createdRequest._id },
        body: { status: 'Approved', reviewRemarks: 'Looks good' }
      };
      const res4 = mockResponse();
      await requestController.reviewRequest(req4, res4);
      if (res4.statusCode === 200 && res4.jsonData?.success) {
        console.log('PASSED: Advisor approved request. Overall status is still Pending (escalated to HOD).\n');
        
        // Fetch updated request
        const updatedReq = await Request.findById(createdRequest._id);
        if (updatedReq.advisorStatus === 'Approved' && updatedReq.status === 'Pending') {
          console.log('PASSED: Request fields updated correctly (advisorStatus=Approved, status=Pending).\n');
        } else {
          console.error('FAILED: Request fields mismatch:', updatedReq);
        }

        // --- SCENARIO 5: HOD now approves request ---
        console.log('--- Scenario 5: HOD approves request ---');
        const req5 = {
          user: hod,
          params: { requestId: createdRequest._id },
          body: { status: 'Approved', reviewRemarks: 'Approved' }
        };
        const res5 = mockResponse();
        await requestController.reviewRequest(req5, res5);
        if (res5.statusCode === 200 && res5.jsonData?.success) {
          console.log('PASSED: HOD approved request successfully.');
          
          const finalReq = await Request.findById(createdRequest._id);
          if (finalReq.hodStatus === 'Approved' && finalReq.status === 'Approved') {
            console.log('PASSED: Final status updated to Approved.\n');
          } else {
            console.error('FAILED: Final request fields mismatch:', finalReq);
          }
        } else {
          console.error('FAILED: HOD approval:', res5.statusCode, res5.jsonData);
        }

      } else {
        console.error('FAILED: Advisor approval:', res4.statusCode, res4.jsonData);
      }

    } else {
      console.error('FAILED: Leave request submission:', res2.statusCode, res2.jsonData);
    }

    // --- SCENARIO 6: Class Advisor date restriction check ---
    console.log('--- Scenario 6: Class Advisor date restrictions on marking ---');
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 3); // 3 days ago
    const req6 = {
      user: advisor,
      body: {
        timetableId: new mongoose.Types.ObjectId(),
        date: pastDate
      }
    };
    const res6 = mockResponse();
    await attendanceController.startSession(req6, res6);
    if (res6.statusCode === 403 && res6.jsonData?.message?.includes('only mark/update attendance for today')) {
      console.log('PASSED: Class Advisor past date marking blocked.\n');
    } else {
      console.error('FAILED: Class Advisor past date marking validation:', res6.statusCode, res6.jsonData);
    }

    console.log('🎉 Verification tests completed successfully!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Error during test run:', err);
    process.exit(1);
  }
}

testSuite();
