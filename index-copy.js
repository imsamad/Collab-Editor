const express = require("express");
const http = require("http");
const socketIO = require("socket.io");
const mongoose = require("mongoose");
const { Delta } = require("quill-delta");

// Connect to MongoDB
mongoose
  .connect("mongodb://localhost:27017/collab_text_editor", {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => {
    console.log("Connected to MongoDB");
  })
  .catch((err) => {
    console.error("Error connecting to MongoDB:", err);
  });

// Create a schema and model for the shared document
const sharedDocumentSchema = new mongoose.Schema({
  ops: [
    {
      type: String,
      index: Number,
      text: String,
    },
  ],
});
const SharedDocument = mongoose.model("SharedDocument", sharedDocumentSchema);

const app = express();
const server = http.createServer(app);
const io = socketIO(server);
app.use(express.static("public"));
let isSaving = false;
const queue = [];

// Function to apply an operation to the shared document
function applyOperation(sharedDocument, operation) {
  const ops = sharedDocument.ops;

  for (let op of operation) {
    if (op.retain && op.retain > 0) {
      const index = op.index || 0;
      ops.splice(index, 0, ...op.attributes);
    } else if (op.delete) {
      const index = op.index || 0;
      ops.splice(index, op.delete);
    } else if (op.insert) {
      const index = op.index || 0;
      ops.splice(index, 0, op.insert);
    }
  }

  sharedDocument.ops = ops;
}

// Function to transform an incoming operation against an existing operation
function transformOperation(operation, againstOperation) {
  const transformedOps = new Delta();

  operation.forEach((op) => {
    transformedOps.push(op);
  });

  againstOperation.forEach((op) => {
    transformedOps.transform(op, true);
  });

  return transformedOps;
}

// Function to handle incoming client connections
io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Event when a user submits an operation
  socket.on("operation", async (operation) => {
    // If the user is not authenticated, ignore the operation
    console.log("operation ", operation);
    // if (!socket.userId) return;
    operation.userId = socket.id;
    // operation?.forEach((op) => {
    //   op.userId = socket.id; // Assign the user ID to each operation
    // });

    // If the document is already being saved, queue the operation and return
    if (isSaving) {
      queue.push(operation);
      return;
    }

    // Get the shared document from the database
    let sharedDocument = await SharedDocument.findById();

    // Apply the operation to the shared document after transforming against existing operations
    let transformedOperation = operation;
    sharedDocument.ops.forEach((existingOp) => {
      transformedOperation = transformOperation(
        transformedOperation,
        existingOp
      );
    });
    if (transformedOperation) {
      // Apply the transformed operation to the shared document
      applyOperation(sharedDocument, transformedOperation);

      // Set the isSaving flag to true to prevent concurrent saves
      isSaving = true;
      // Persist the operation to MongoDB
      await sharedDocument.save();

      // Clear the isSaving flag
      isSaving = false;

      // If there are queued operations, apply and save them recursively
      while (queue.length > 0) {
        const nextOperation = queue.shift();
        applyOperation(sharedDocument, nextOperation);
        isSaving = true;
        await sharedDocument.save();
        isSaving = false;
      }

      // Broadcast the operation to all connected users except the sender
      socket.broadcast.emit("operation", transformedOperation);
    }
  });

  // Event when a user disconnects
  socket.on("disconnect", () => {
    console.log("A user disconnected:", socket.id);
  });
});

// Start the server
const port = process.env.PORT || 3000;

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
