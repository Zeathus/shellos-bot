trap ctrl_c INT

loop=1

function ctrl_c() {
	echo "Stopping..."
	loop=0
}

while [ $loop -eq 1 ]; do npm run start; done
