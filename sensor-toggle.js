(function () {

var motionEnabled = true;
var orientEnabled = true;

/* block events */
function blockMotion(e){
  if(!motionEnabled){
    e.stopImmediatePropagation();
  }
}

function blockOrient(e){
  if(!orientEnabled){
    e.stopImmediatePropagation();
  }
}

window.addEventListener("devicemotion", blockMotion, true);
window.addEventListener("deviceorientation", blockOrient, true);


/* UI create */
var box = document.createElement("div");
box.style.position = "fixed";
box.style.bottom = "10px";
box.style.right = "10px";
box.style.background = "#000";
box.style.color = "#fff";
box.style.border = "2px solid #555";
box.style.padding = "8px";
box.style.zIndex = "99999";
box.style.fontSize = "12px";

var btnMotion = document.createElement("button");
var btnOrient = document.createElement("button");

btnMotion.innerHTML = "Accel ON";
btnOrient.innerHTML = "Gyro ON";

btnMotion.style.display="block";
btnOrient.style.display="block";
btnMotion.style.margin="4px";
btnOrient.style.margin="4px";

/* toggle functions */

btnMotion.onclick=function(){

  motionEnabled=!motionEnabled;

  if(motionEnabled){
    btnMotion.innerHTML="Accel ON";
    btnMotion.style.background="#060";
  }else{
    btnMotion.innerHTML="Accel OFF";
    btnMotion.style.background="#600";
  }

};

btnOrient.onclick=function(){

  orientEnabled=!orientEnabled;

  if(orientEnabled){
    btnOrient.innerHTML="Gyro ON";
    btnOrient.style.background="#060";
  }else{
    btnOrient.innerHTML="Gyro OFF";
    btnOrient.style.background="#600";
  }

};

box.appendChild(btnMotion);
box.appendChild(btnOrient);

document.body.appendChild(box);

})();
