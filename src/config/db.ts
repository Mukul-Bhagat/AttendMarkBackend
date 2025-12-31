import mongoose from 'mongoose';

// Fix Mongoose deprecation warning
mongoose.set('strictQuery', false);

const connectDB = async () => {
  try {
    const mongoUri = process.env.MONGO_URI;
    
    if (!mongoUri) {
      console.error('Error: MONGO_URI is not defined in environment variables');
      console.error('Please create a .env file in the backend directory with:');
      console.error('MONGO_URI=mongodb://localhost:27017/attendancemark');
      process.exit(1);
    }

    if (!mongoUri.startsWith('mongodb://') && !mongoUri.startsWith('mongodb+srv://')) {
      console.error('Error: Invalid MongoDB connection string format');
      console.error('Connection string must start with "mongodb://" or "mongodb+srv://"');
      console.error(`Current value: ${mongoUri.substring(0, 20)}...`);
      process.exit(1);
    }

    const conn = await mongoose.connect(mongoUri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
    return conn;
  } catch (error: any) {
    if (error.message.includes('authentication failed') || error.message.includes('bad auth')) {
      console.error('❌ MongoDB Authentication Failed');
      console.error('');
      console.error('Possible causes:');
      console.error('1. Incorrect username/password in your connection string');
      console.error('2. MongoDB Atlas: User may not exist or password is wrong');
      console.error('3. MongoDB Atlas: IP address not whitelisted');
      console.error('');
      console.error('For local MongoDB (no authentication):');
      console.error('  MONGO_URI=mongodb://localhost:27017/attendancemark');
      console.error('');
      console.error('For MongoDB Atlas (with credentials):');
      console.error('  MONGO_URI=mongodb+srv://USERNAME:PASSWORD@cluster.mongodb.net/attendancemark?retryWrites=true&w=majority');
      console.error('');
      console.error('Make sure to replace USERNAME and PASSWORD with your actual credentials');
    } else {
      console.error(`❌ MongoDB Connection Error: ${error.message}`);
    }
    process.exit(1);
  }
};

export default connectDB;

