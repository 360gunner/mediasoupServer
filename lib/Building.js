const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const Schema = mongoose.Schema;

const BuildingSchema = new Schema({
    name: {
        type: String,
        unique: true,
    },
    password: {
        type: String
    },
    created: {
        type: Date,
        default: Date.now
    },
    roomIds: [{
        type: String
    }]
});

BuildingSchema.pre('save', function(next){
    var build = this;
    const saltRounds = 10;
    bcrypt.hash(build.password, saltRounds, (err, hash) => {
        this.password=hash;
        next();
      });
})


BuildingSchema.methods.comparePassword = (password,thispassword) => {
    return bcrypt.compareSync(password, thispassword)
}

module.exports = mongoose.model('Building',BuildingSchema);