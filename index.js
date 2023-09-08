const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Connect to MongoDB using Mongoose
mongoose.connect('mongodb://localhost:27017/ot_collaboration', {
   useNewUrlParser: true,
   useUnifiedTopology: true,
});

// Define a schema for the shared document
const sharedDocumentSchema = new mongoose.Schema({
   ops: [
      {
         userId: String,
         type: { type: String, enum: ['insert', 'delete'] },
         index: Number,
         text: String,
         deleteLength: Number,
      },
   ],
});

// Create a model for the shared document
const SharedDocument = mongoose.model('SharedDocument', sharedDocumentSchema);

// Apply an operation to the shared document
function applyOperation(sharedDocument, operation) {
   if (operation.type === 'insert') {
      applyInsertOperation(sharedDocument, operation);
   } else if (operation.type === 'delete') {
      applyDeleteOperation(sharedDocument, operation);
   }
}

// Apply an insertion operation to the shared document
function applyInsertOperation(sharedDocument, operation) {
   if (sharedDocument.ops.length === 0) {
      sharedDocument.ops.push(operation);
   } else {
      let index = 0;
      while (
         index < sharedDocument.ops.length &&
         sharedDocument.ops[index].index < operation.index
      ) {
         index++;
      }
      sharedDocument.ops.splice(index, 0, operation);

      // Transform the newly inserted operation against the existing operations
      for (let i = index + 1; i < sharedDocument.ops.length; i++) {
         sharedDocument.ops[i].index += operation.text.length;
      }
   }
}

// Apply a deletion operation to the shared document
function applyDeleteOperation(sharedDocument, operation) {
   let index = 0;
   while (
      index < sharedDocument.ops.length &&
      sharedDocument.ops[index].index < operation.index
   ) {
      index++;
   }

   // Apply the deletion to the shared document
   if (
      index < sharedDocument.ops.length &&
      sharedDocument.ops[index].index === operation.index
   ) {
      // The deletion operation matches an existing operation, so just remove it
      sharedDocument.ops.splice(index, 1);

      // Transform the existing operations after the deletion
      for (let i = index; i < sharedDocument.ops.length; i++) {
         sharedDocument.ops[i].index -= operation.deleteLength;
      }
   } else {
      // The deletion operation does not match an existing operation,
      // so add it to the shared document as a delete operation
      sharedDocument.ops.push(operation);

      // Transform the newly added deletion against the existing operations
      for (let i = sharedDocument.ops.length - 2; i >= 0; i--) {
         sharedDocument.ops[i].index += operation.deleteLength;
      }
   }
}

// Transform an operation against another operation
function transformOperation(operation, againstOperation) {
   if (operation.type === 'insert' && againstOperation.type === 'insert') {
      if (
         operation.index < againstOperation.index ||
         (operation.index === againstOperation.index &&
            operation.userId < againstOperation.userId)
      ) {
         return operation;
      } else {
         return {
            ...operation,
            index: operation.index + againstOperation.text.length,
         };
      }
   } else if (
      operation.type === 'insert' &&
      againstOperation.type === 'delete'
   ) {
      if (operation.index <= againstOperation.index) {
         return operation;
      } else if (
         operation.index >=
         againstOperation.index + againstOperation.deleteLength
      ) {
         return {
            ...operation,
            index: operation.index - againstOperation.deleteLength,
         };
      } else {
         return null; // Deletion deletes inserted text, so the operation is nullified
      }
   } else if (
      operation.type === 'delete' &&
      againstOperation.type === 'insert'
   ) {
      if (operation.index < againstOperation.index) {
         return operation;
      } else if (
         operation.index >=
         againstOperation.index + againstOperation.text.length
      ) {
         return {
            ...operation,
            index: operation.index - againstOperation.text.length,
         };
      } else {
         return null; // Insertion inserts text that was deleted, so the operation is nullified
      }
   } else if (
      operation.type === 'delete' &&
      againstOperation.type === 'delete'
   ) {
      if (operation.index === againstOperation.index) {
         return null; // Two deletions at the same index nullify each other
      } else if (operation.index < againstOperation.index) {
         return operation;
      } else {
         return {
            ...operation,
            index: operation.index - againstOperation.deleteLength,
         };
      }
   }
}

// Flag to indicate if the document is being saved
let isSaving = false;

// Queue to store pending operations
const queue = [];

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Event when a client connects
io.on('connection', async (socket) => {
   console.log('New user connected');

   // Fetch the shared document from MongoDB and send it to the new user
   let sharedDocument = await SharedDocument.findOne();
   if (!sharedDocument) {
      // If the document is not found, create a new one
      sharedDocument = new SharedDocument();
      await sharedDocument.save();
   }

   socket.emit('document', sharedDocument.ops);

   // Event when a user submits an operation
   socket.on('operation', async (operation) => {
      console.log('socket.id ', socket.id);
      operation.userId = socket.id; // Assign a unique ID to the operation

      // If the document is already being saved, queue the operation and return
      if (isSaving) {
         queue.push(operation);
         return;
      }

      let transformedOperation = operation; // Store the transformed operation in a new variable
      sharedDocument.ops.forEach((existingOp) => {
         transformedOperation = transformOperation(
            transformedOperation,
            existingOp
         ); // Apply transformation to the new variable
      });

      if (!transformedOperation) return;
      // Apply the operation to the shared document
      applyOperation(sharedDocument, transformedOperation);

      // Set the isSaving flag to true to prevent concurrent saves
      isSaving = true;

      // Persist the operation to MongoDB
      await sharedDocument.save();

      // Clear the isSaving flag
      isSaving = false;

      // If there are queued operations, apply and save them recursively
      if (queue.length > 0) {
         const nextOperation = queue.shift();
         applyOperation(sharedDocument, nextOperation);
         isSaving = true;
         await sharedDocument.save();
         isSaving = false;
      }

      // Broadcast the operation to all connected users except the sender
      socket.broadcast.emit('operation', transformedOperation);
   });
});

// Start the server
const port = 3000;
server.listen(port, () => {
   console.log(`Server running on http://localhost:${port}`);
});
