CC ?= cc
CFLAGS = -O2 -Wall -Wextra -static-libgcc

isidore-sandbox: landlock-sandbox.c
	$(CC) $(CFLAGS) -o $@ $<

clean:
	rm -f isidore-sandbox

.PHONY: clean