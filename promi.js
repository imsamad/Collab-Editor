const { default: axios } = require("axios");

const results = [];

const uri = "https://jsonplaceholder.typicode.com/todos/";

(async () => {
  for (let i = 0; i < 6; i++) {
    try {
      console.log("i ", i);
      const { data } = await axios.get(uri + i);

      results.push(data);
    } catch (err) {}
  }
  console.log("csdjkbcn");
  console.log(results);
})();
