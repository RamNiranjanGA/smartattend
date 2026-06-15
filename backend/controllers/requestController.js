const Request = require('../models/Request');
const Attendance = require('../models/Attendance');
const Mark = require('../models/Mark');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { createLog } = require('../utils/logger');

// Helper to notify all Admin users of important changes made by HOD
const notifyAdmins = async (message, type = 'Info', link = '') => {
  try {
    const admins = await User.find({ role: 'Admin' }).select('_id');
    const notifications = admins.map(admin => ({
      user: admin._id,
      message,
      type,
      link
    }));
    if (notifications.length > 0) {
      await Notification.insertMany(notifications);
    }
  } catch (error) {
    console.error('Error notifying admins:', error);
  }
};

exports.submitRequest = async (req, res) => {
  try {
    const { targetModel, targetRecord, reason, newValue } = req.body;

    if (!['Attendance', 'Mark', 'Leave'].includes(targetModel)) {
      return res.status(400).json({ success: false, message: 'Invalid target model.' });
    }

    if (targetModel === 'Leave' && newValue?.leaveType === 'OD' && !newValue?.proofImage) {
      return res.status(400).json({ success: false, message: 'On-Duty (OD) request requires attaching a proof form.' });
    }

    const reqUserId = req.user._id || req.user.id;

    // Fetch the record to get oldValue
    let record;
    let oldValue;
    let finalTargetRecord = targetModel === 'Leave' ? (targetRecord || reqUserId) : targetRecord;

    if (targetModel === 'Attendance') {
      const mongoose = require('mongoose');
      let isIdValid = mongoose.Types.ObjectId.isValid(finalTargetRecord);
      if (isIdValid) {
        record = await Attendance.findById(finalTargetRecord);
      }
      
      if (!record) {
        // Try looking up by studentId and sessionId
        const { studentId, sessionId } = req.body;
        if (studentId && sessionId) {
          record = await Attendance.findOne({ session: sessionId, student: studentId });
          if (!record) {
            const Session = require('../models/Session');
            const targetSession = await Session.findById(sessionId);
            if (targetSession) {
              const studentDetails = await User.findById(studentId).select('department year semester section').lean();
              record = new Attendance({
                session: sessionId,
                student: studentId,
                subject: targetSession.subject,
                date: targetSession.date,
                period: targetSession.period || 'H1',
                status: 'Absent',
                markedBy: 'Faculty',
                entryType: 'Manual',
                locked: true,
                faculty: targetSession.faculty,
                department: studentDetails?.department || targetSession.department,
                year: studentDetails?.year || targetSession.year,
                semester: studentDetails?.semester || targetSession.semester,
                section: studentDetails?.section || targetSession.section
              });
              await record.save();
            }
          }
          if (record) {
            finalTargetRecord = record._id;
          }
        }
      }

      if (!record) return res.status(404).json({ success: false, message: 'Attendance record not found.' });
      oldValue = record.status;
    } else if (targetModel === 'Mark') {
      record = await Mark.findById(finalTargetRecord);
      if (!record) return res.status(404).json({ success: false, message: 'Mark record not found.' });
      oldValue = { internal: record.internal, external: record.external, total: record.total };
    } else if (targetModel === 'Leave') {
      oldValue = 'Pending';
    }

    const newRequest = await Request.create({
      requestedBy: reqUserId,
      targetModel,
      targetRecord: finalTargetRecord,
      reason,
      oldValue,
      newValue,
    });

    await createLog('Submitted Correction Request', req.user, 'Request', newRequest._id, {
      oldValue,
      newValue,
      reason,
      targetDept: req.user.department || 'General',
      details: `Submitted correction request for ${targetModel}`
    });

    res.status(201).json({ success: true, message: 'Request submitted successfully.', request: newRequest });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.', error: error.message });
  }
};

exports.getRequests = async (req, res) => {
  try {
    const query = {};
    
    // Non-admin roles (HOD, Class Advisor) should not see PasswordReset requests
    if (['HoD', 'Class Advisor'].includes(req.user.role)) {
      query.targetModel = { $ne: 'PasswordReset' };
    }

    if (req.user.role === 'HoD') {
      // HODs see requests for students and advisors in their department:
      // - Student Leave/OD requests only after the Class Advisor has approved them (advisorStatus === 'Approved')
      // - Student correction requests (Attendance/Mark) directly
      // - Requests submitted by department staff (Class Advisors)
      const deptStudents = await User.find({
        role: 'Student',
        department: req.user.department
      }).select('_id');
      const studentIds = deptStudents.map(s => s._id);

      const deptFaculty = await User.find({
        role: 'Class Advisor',
        department: req.user.department
      }).select('_id');
      const facultyIds = deptFaculty.map(f => f._id);

      query.$or = [
        {
          requestedBy: { $in: studentIds },
          targetModel: 'Leave',
          advisorStatus: 'Approved'
        },
        {
          requestedBy: { $in: studentIds },
          targetModel: { $ne: 'Leave' }
        },
        {
          requestedBy: { $in: facultyIds }
        }
      ];
    } else if (req.user.role === 'Class Advisor') {
      const adv = req.user.classAdvisorDetails || {};
      if (adv.isClassAdvisor) {
        const advisedStudents = await User.find({
          role: 'Student',
          department: adv.department,
          year: adv.year,
          semester: adv.semester,
          section: adv.section
        }).select('_id');
        const advisedIds = advisedStudents.map(s => s._id);
        query.$or = [
          { requestedBy: req.user._id || req.user.id },
          { requestedBy: { $in: advisedIds } }
        ];
      } else {
        query.requestedBy = req.user._id || req.user.id;
      }
    } else if (req.user.role === 'Student') {
      query.requestedBy = req.user._id || req.user.id;
    }

    if (req.query.status) {
      query.status = req.query.status;
    }

    const requests = await Request.find(query)
      .populate('requestedBy', 'name email role department year semester section')
      .populate('reviewedBy', 'name role')
      .sort({ createdAt: -1 });
    res.status(200).json({ success: true, requests });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.', error: error.message });
  }
};

exports.reviewRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { status, reviewRemarks } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Status must be Approved or Rejected.' });
    }

    const request = await Request.findById(requestId).populate('requestedBy');
    if (!request) {
      return res.status(404).json({ success: false, message: 'Request not found.' });
    }

    const isLeave = request.targetModel === 'Leave';

    // 1. Stage and Role Check
    if (isLeave) {
      if (req.user.role === 'Class Advisor') {
        const adv = req.user.classAdvisorDetails || {};
        const isAdvisedStudent = 
          request.requestedBy.role === 'Student' &&
          request.requestedBy.department === adv.department &&
          String(request.requestedBy.year) === String(adv.year) &&
          String(request.requestedBy.semester) === String(adv.semester) &&
          request.requestedBy.section === adv.section;
          
        if (!isAdvisedStudent) {
          return res.status(403).json({ success: false, message: 'Access denied: You can only review requests for students in your advised class.' });
        }

        if (request.advisorStatus !== 'Pending' || request.status !== 'Pending') {
          return res.status(400).json({ success: false, message: 'Request advisor stage has already been processed.' });
        }

        request.advisorStatus = status;
        request.advisorReviewedBy = req.user._id || req.user.id;
        request.advisorRemarks = reviewRemarks;

        if (status === 'Rejected') {
          request.status = 'Rejected';
          request.reviewedBy = req.user._id || req.user.id;
          request.reviewRemarks = reviewRemarks;
        }

      } else if (req.user.role === 'HoD') {
        if (request.requestedBy.department !== req.user.department) {
          return res.status(403).json({ success: false, message: 'Access denied: Request is outside your department.' });
        }

        if (request.advisorStatus !== 'Approved') {
          return res.status(403).json({ success: false, message: 'Access denied: This request must be approved by the Class Advisor first.' });
        }

        if (request.hodStatus !== 'Pending' || request.status !== 'Pending') {
          return res.status(400).json({ success: false, message: 'Request HOD stage has already been processed.' });
        }

        request.hodStatus = status;
        request.hodReviewedBy = req.user._id || req.user.id;
        request.hodRemarks = reviewRemarks;
        
        request.status = status;
        request.reviewedBy = req.user._id || req.user.id;
        request.reviewRemarks = reviewRemarks;

      } else if (req.user.role === 'Admin') {
        request.advisorStatus = status;
        request.hodStatus = status;
        request.status = status;
        request.reviewedBy = req.user._id || req.user.id;
        request.reviewRemarks = reviewRemarks;
      } else {
        return res.status(403).json({ success: false, message: 'Access denied: Only Class Advisors or HODs can review leave requests.' });
      }
    } else {
      // Non-Leave Requests (Attendance, Mark, PasswordReset) - Single Stage
      if (req.user.role === 'HoD') {
        if (request.requestedBy.department !== req.user.department) {
          return res.status(403).json({ success: false, message: 'Access denied: Request is outside your department.' });
        }

        if (request.requestedBy.role === 'Student') {
          const student = request.requestedBy;
          const advisor = await User.findOne({
            role: 'Class Advisor',
            'classAdvisorDetails.isClassAdvisor': true,
            'classAdvisorDetails.department': student.department,
            'classAdvisorDetails.year': student.year,
            'classAdvisorDetails.semester': student.semester,
            'classAdvisorDetails.section': student.section,
            isActive: true
          });
          if (advisor) {
            return res.status(403).json({ success: false, message: 'Access denied: This request must be reviewed by the Class Advisor.' });
          }
        }
      } else if (req.user.role === 'Class Advisor') {
        const adv = req.user.classAdvisorDetails || {};
        const isAdvisedStudent = 
          request.requestedBy.role === 'Student' &&
          request.requestedBy.department === adv.department &&
          String(request.requestedBy.year) === String(adv.year) &&
          String(request.requestedBy.semester) === String(adv.semester) &&
          request.requestedBy.section === adv.section;
          
        if (!isAdvisedStudent) {
          return res.status(403).json({ success: false, message: 'Access denied: You can only review requests for students in your advised class.' });
        }
      } else if (req.user.role !== 'Admin') {
        return res.status(403).json({ success: false, message: 'Access denied: Role not authorized to review requests.' });
      }

      if (request.status !== 'Pending') {
        return res.status(400).json({ success: false, message: 'Request is already processed.' });
      }

      request.status = status;
      request.reviewedBy = req.user._id || req.user.id;
      request.reviewRemarks = reviewRemarks;
    }

    // 2. Apply Changes if status is 'Approved'
    if (request.status === 'Approved') {
      if (request.targetModel === 'Attendance') {
        await Attendance.findByIdAndUpdate(request.targetRecord, { status: request.newValue, updatedBy: req.user._id || req.user.id, remarks: 'Updated via approved request' });
      } else if (request.targetModel === 'Mark') {
        const { internal, external } = request.newValue;
        const total = (Number(internal) || 0) + (Number(external) || 0);
        await Mark.findByIdAndUpdate(request.targetRecord, { internal, external, total, updatedBy: req.user._id || req.user.id, remarks: 'Updated via approved request' });
      } else if (request.targetModel === 'Leave') {
        const studentId = request.requestedBy._id || request.requestedBy;
        const student = await User.findById(studentId);
        if (student) {
          const startDate = new Date(request.newValue.startDate);
          const endDate = new Date(request.newValue.endDate);
          const leaveType = request.newValue.leaveType || 'General';

          let attendanceStatus = 'On-Duty';
          if (leaveType === 'Medical Leave' || leaveType === 'ML') {
            attendanceStatus = 'Medical Leave';
          } else if (leaveType === 'Casual Leave' || leaveType === 'CL') {
            attendanceStatus = 'Casual Leave';
          }

          // Fetch all timetable entries for this student's class
          const Timetable = require('../models/Timetable');
          const timetables = await Timetable.find({
            department: student.department,
            year: student.year,
            semester: student.semester,
            section: student.section
          });

          // Loop through each date in the range
          const currentDate = new Date(startDate);
          currentDate.setHours(0,0,0,0);
          const endLimitDate = new Date(endDate);
          endLimitDate.setHours(23,59,59,999);

          const Session = require('../models/Session');
          const AcademicCalendar = require('../models/AcademicCalendar');

          while (currentDate <= endLimitDate) {
            const dayStart = new Date(currentDate);
            dayStart.setHours(0,0,0,0);
            const dayEnd = new Date(currentDate);
            dayEnd.setHours(23,59,59,999);

            // Check if it's a holiday/non-working day
            const calendarEntry = await AcademicCalendar.findOne({
              date: { $gte: dayStart, $lte: dayEnd }
            });

            if (!calendarEntry || calendarEntry.type !== 'Holiday') {
              const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
              const dayOfWeekName = days[currentDate.getDay()];

              // Find timetable entries for this day of the week
              const slotsForToday = timetables.filter(t => t.dayOfWeek === dayOfWeekName);

              for (const slot of slotsForToday) {
                // Find or create session for this timetable slot and date
                let session = await Session.findOne({
                  timetable: slot._id,
                  date: { $gte: dayStart, $lte: dayEnd }
                });

                if (!session) {
                  const { v4: uuidv4 } = require('uuid');
                  session = new Session({
                    timetable: slot._id,
                    subject: slot.subject,
                    faculty: slot.faculty,
                    date: new Date(currentDate),
                    period: slot.period,
                    locked: true,
                    isActive: false,
                    qrToken: uuidv4(),
                    department: student.department,
                    year: student.year,
                    semester: student.semester,
                    section: student.section
                  });
                  await session.save();
                }

                // Create or update attendance record
                await Attendance.findOneAndUpdate(
                  {
                    session: session._id,
                    student: studentId
                  },
                  {
                    status: attendanceStatus,
                    updatedBy: req.user._id || req.user.id,
                    remarks: `Leave approved: ${leaveType}`,
                    subject: slot.subject,
                    date: new Date(currentDate),
                    faculty: slot.faculty,
                    department: student.department,
                    year: student.year,
                    semester: student.semester,
                    section: student.section,
                    entryType: 'Manual',
                    markedBy: 'Admin'
                  },
                  { upsert: true, new: true }
                );
              }
            }

            currentDate.setDate(currentDate.getDate() + 1);
          }
        }
      } else if (request.targetModel === 'PasswordReset') {
        const studentId = request.requestedBy._id || request.requestedBy;
        const targetUser = await User.findById(studentId);
        if (targetUser) {
          const targetDob = targetUser.dob;
          if (!targetDob) {
            return res.status(400).json({ success: false, message: 'User does not have a Date of Birth set in their profile.' });
          }
          const d = new Date(targetDob);
          if (isNaN(d.getTime())) {
            return res.status(400).json({ success: false, message: 'Invalid Date of Birth format.' });
          }
          const dd = String(d.getDate()).padStart(2, '0');
          const mm = String(d.getMonth() + 1).padStart(2, '0');
          const yyyy = d.getFullYear();
          const dobString = `${dd}${mm}${yyyy}`;

          const bcrypt = require('bcryptjs');
          const salt = await bcrypt.genSalt(10);
          targetUser.password = await bcrypt.hash(dobString, salt);
          targetUser.isFirstLogin = true;
          await targetUser.save();
        }
      }
    }

    await request.save();

    await createLog(`Request ${status}`, req.user, 'Request', request._id, {
      oldValue: request.oldValue,
      newValue: request.newValue,
      reason: reviewRemarks || `Correction request reviewed by ${req.user.role}`,
      targetDept: req.user.department || 'General',
      details: `Processed correction request: ${request.targetModel} update was ${status.toLowerCase()}`
    });

    if (req.user.role === 'HoD') {
      await notifyAdmins(`HOD ${req.user.name} (${req.user.department}) reviewed ${request.targetModel} request: ${status}`, 'Info');
    }

    res.status(200).json({ success: true, message: `Request ${status.toLowerCase()} successfully.`, request });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error.', error: error.message });
  }
};
